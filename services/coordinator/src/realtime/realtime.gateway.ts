import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import { AppConfigService, parseCorsOrigins } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveRole,
  isTokenClass,
  MAY_OPEN_SOCKET,
  Role,
  TokenClass,
} from '../auth/role.util';
import { jwtVerifyOptions } from '../auth/jwt-options';

const CORS_ORIGINS = parseCorsOrigins(process.env.CORS_ORIGINS);

const PRESENCE_BUMP_INTERVAL_MS = 60_000;

const JOIN_ORDER_RATE_LIMIT = 30;
const JOIN_ORDER_RATE_WINDOW_MS = 10_000;

export const MAX_SOCKETS_PER_ADDRESS = 10;

export const CONNECT_RATE_LIMIT = 20;
const CONNECT_RATE_WINDOW_MS = 10_000;

export interface OrderForRealtime {
  id: string;
  status: string;
  flow: string;
  userAddress: string;
  lpWallet?: string | null;
}

interface SocketData {
  address: string;
  role: Role;
}

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly log = new Logger('RealtimeGateway');

  @WebSocketServer()
  server!: Server;

  private socketsByAddress = new Map<string, Set<string>>();

  private lpAddressesOnline = new Set<string>();

  private joinAttempts = new Map<string, { count: number; windowStart: number }>();

  private connectAttempts = new Map<string, { count: number; windowStart: number }>();
  private presenceInterval?: ReturnType<typeof setInterval>;
  private expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private jwt: JwtService,
    private cfg: AppConfigService,
    private prisma: PrismaService,
  ) {
    this.presenceInterval = setInterval(() => {
      this.bumpLpPresence().catch((e) =>
        this.log.warn(`presence bump failed: ${e instanceof Error ? e.message : String(e)}`),
      );
      this.pruneConnectAttempts();
    }, PRESENCE_BUMP_INTERVAL_MS);

    this.presenceInterval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.presenceInterval) clearInterval(this.presenceInterval);
  }

  async handleConnection(socket: Socket): Promise<void> {
    const token = this.extractToken(socket);
    if (!token) {
      socket.disconnect(true);
      return;
    }

    let address: string;
    let cls: TokenClass;
    let expiresAt: number;
    try {
      const payload = this.jwt.verify<{ sub?: unknown; cls?: unknown; exp?: unknown }>(
        token,
        jwtVerifyOptions(this.cfg),
      );
      if (!payload || typeof payload.sub !== 'string' || !payload.sub) {
        throw new Error('missing sub claim');
      }
      if (!isTokenClass(payload.cls) || !MAY_OPEN_SOCKET.includes(payload.cls)) {
        throw new Error('this token class may not open a socket');
      }
      if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
        throw new Error('token has no expiry');
      }
      address = payload.sub;
      cls = payload.cls;
      expiresAt = payload.exp * 1000;
    } catch {
      socket.disconnect(true);
      return;
    }

    if (!this.checkConnectRate(address)) {
      socket.disconnect(true);
      return;
    }

    const existingSet = this.socketsByAddress.get(address);
    if (existingSet && existingSet.size >= MAX_SOCKETS_PER_ADDRESS) {
      socket.disconnect(true);
      return;
    }
    const set = existingSet ?? new Set<string>();
    set.add(socket.id);
    this.socketsByAddress.set(address, set);

    let role: Role;
    try {
      role = await resolveRole(address, this.prisma, this.cfg.adminAddresses, cls);
    } catch (err) {
      this.log.warn(
        `connect refused for ${address}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.releaseSocketSlot(address, socket.id);
      socket.disconnect(true);
      return;
    }

    socket.data = { address, role } satisfies SocketData;

    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      this.releaseSocketSlot(address, socket.id);
      socket.disconnect(true);
      return;
    }
    const expiryTimer = setTimeout(() => {
      this.expiryTimers.delete(socket.id);
      socket.disconnect(true);
    }, remaining);
    if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
    this.expiryTimers.set(socket.id, expiryTimer);

    await socket.join(`user:${address}`);

    if (role === 'admin') {
      await socket.join('admin:orders');
    }

    if (role === 'lp') {
      await socket.join('lp:assignments');
      this.lpAddressesOnline.add(address);

      try {
        await this.prisma.lp.update({
          where: { stellarAddress: address },
          data: { lastHeartbeatAt: new Date() },
        });
      } catch (e) {
        this.log.warn(
          `presence liveness-bump failed for ${address}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    this.joinAttempts.delete(socket.id);
    const data = socket.data as SocketData | undefined;
    if (!data?.address) return;

    this.releaseSocketSlot(data.address, socket.id);
    const stillConnected = (this.socketsByAddress.get(data.address)?.size ?? 0) > 0;

    if (data.role === 'lp' && !stillConnected) {
      this.lpAddressesOnline.delete(data.address);
    }
  }

  @SubscribeMessage('join:order')
  async handleJoinOrder(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { orderId?: unknown },
  ): Promise<void> {
    const data = socket.data as SocketData | undefined;
    if (!data?.address) return;

    try {
      const role = await resolveRole(data.address, this.prisma, this.cfg.adminAddresses, 'session');
      if (role !== data.role) {
        socket.data = { address: data.address, role } satisfies SocketData;
      }
    } catch {
      this.log.warn(`join:order refused: ${data.address} is no longer a proven wallet`);
      socket.disconnect(true);
      return;
    }

    if (!this.checkJoinRate(socket.id)) {
      socket.emit('join:order:error', { reason: 'rate_limited' });
      return;
    }

    const orderId = typeof body?.orderId === 'string' ? body.orderId : undefined;
    if (!orderId) {
      socket.emit('join:order:error', { reason: 'invalid_order_id' });
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userAddress: true, lpWallet: true },
    });

    const authorized =
      !!order &&
      (data.role === 'admin' ||
        order.userAddress === data.address ||
        (data.role === 'lp' && order.lpWallet === data.address));

    if (!authorized) {
      socket.emit('join:order:error', { orderId, reason: 'forbidden' });
      return;
    }

    await socket.join(`order:${orderId}`);
  }

  emitOrderUpdate(order: OrderForRealtime): void {
    try {
      if (!this.server) return;
      const payload = {
        id: order.id,
        status: order.status,
        flow: order.flow,
        updated_at: new Date().toISOString(),
      };
      this.server.to(`order:${order.id}`).emit('order:update', payload);
      this.server.to(`user:${order.userAddress}`).emit('order:update', payload);
      if (order.lpWallet) {
        this.server.to(`user:${order.lpWallet}`).emit('order:update', payload);
      }

      this.server.to('admin:orders').emit('order:update', payload);

      this.server.to('lp:assignments').emit('assignments:changed', {
        orderId: order.id,
        status: order.status,
      });
    } catch (e) {
      this.log.warn(
        `emitOrderUpdate failed for order ${order.id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private releaseSocketSlot(address: string, socketId: string): void {
    const set = this.socketsByAddress.get(address);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.socketsByAddress.delete(address);
  }

  private extractToken(socket: Socket): string | undefined {
    const authToken = (socket.handshake.auth as Record<string, unknown> | undefined)?.['token'];
    if (typeof authToken === 'string' && authToken) return authToken;
    const header = socket.handshake.headers?.authorization;
    const h = Array.isArray(header) ? header[0] : header;
    const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
    return m ? m[1] : undefined;
  }

  private checkJoinRate(socketId: string): boolean {
    const now = Date.now();
    const rec = this.joinAttempts.get(socketId);
    if (!rec || now - rec.windowStart > JOIN_ORDER_RATE_WINDOW_MS) {
      this.joinAttempts.set(socketId, { count: 1, windowStart: now });
      return true;
    }
    rec.count += 1;
    return rec.count <= JOIN_ORDER_RATE_LIMIT;
  }

  private checkConnectRate(address: string): boolean {
    const now = Date.now();
    const rec = this.connectAttempts.get(address);
    if (!rec || now - rec.windowStart > CONNECT_RATE_WINDOW_MS) {
      this.connectAttempts.set(address, { count: 1, windowStart: now });
      return true;
    }
    rec.count += 1;
    return rec.count <= CONNECT_RATE_LIMIT;
  }

  private pruneConnectAttempts(): void {
    const now = Date.now();
    for (const [address, rec] of this.connectAttempts) {
      if (now - rec.windowStart > CONNECT_RATE_WINDOW_MS) this.connectAttempts.delete(address);
    }
  }

  private async bumpLpPresence(): Promise<void> {
    if (this.lpAddressesOnline.size === 0) return;
    const addresses = Array.from(this.lpAddressesOnline);
    try {
      await this.prisma.lp.updateMany({
        where: { stellarAddress: { in: addresses }, status: 'APPROVED' },
        data: { lastHeartbeatAt: new Date() },
      });
    } catch (e) {
      this.log.warn(`presence bump write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
