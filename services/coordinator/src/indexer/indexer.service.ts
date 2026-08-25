import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { NotificationService } from '../notification/notification.service';
import { StellarReadService, withRpcTimeout } from '../stellar/stellar-read.service';
import { contractIdFor } from '../order/order.params';
import { verifyTradeMatchesOrder } from '../order/trade-binding';
import { userLostDispute, providerLostDispute } from '../reputation/dispute-outcome';
import { UserReputationService } from '../reputation/user-reputation.service';

export function attributeDisputer(
  by: string,
  userAddress: string,
  lpWallet: string | null,
): 'user' | 'lp' | 'resolver' {
  if (by === userAddress) return 'user';
  if (lpWallet && by === lpWallet) return 'lp';
  return 'resolver';
}

export const EVENT_STATUS: Record<string, string> = {
  trade_created: 'FUNDED',
  fiat_paid: 'FIAT_PAID',
  released: 'RELEASED',
  early_released: 'RELEASED',
  refunded: 'REFUNDED',
  disputed: 'DISPUTED',
};

const POST_SETTLE_TERMINAL = ['RELEASED', 'REFUNDED'] as const;

const NOT_YET_BOUND_ON_CHAIN = ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'EXPIRED'];

const STATUS_BEFORE: Record<string, string[]> = {
  FUNDED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'EXPIRED'],
  FIAT_PAID: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'EXPIRED'],
  DISPUTED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'EXPIRED'],
  RELEASED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED'],
  REFUNDED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED'],
};

const LOOKBACK_LEDGERS = 17280;

@Injectable()
export class IndexerService {
  private readonly log = new Logger('Indexer');
  private running = false;

  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private notifications: NotificationService,
    private stellar: StellarReadService,
    private userReputation: UserReputationService,
  ) {}

  @Cron('*/10 * * * * *')
  async poll() {
    if (this.running) return;
    this.running = true;
    try {
      await this.index();
    } catch (e) {
      this.log.warn(`index error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private contractIdsToWatch(): string[] {
    return Array.from(new Set([this.cfg.escrowContractId, ...this.cfg.escrowContractIdsExtra]));
  }

  private async index() {
    const server = new Server(this.cfg.rpcUrl);
    const state = await this.prisma.indexerState.findUnique({ where: { id: 1 } });

    const baseFilter = {
      filters: [{ type: 'contract' as const, contractIds: this.contractIdsToWatch() }],
      limit: 200,
    };

    let res;
    if (state?.cursor) {
      try {
        res = await withRpcTimeout(server.getEvents({ ...baseFilter, cursor: state.cursor }), 'getEvents');
      } catch (err) {
        if (!isRetentionError(err)) {
          this.log.warn(
            `getEvents failed (transient — cursor preserved, retrying same cursor next tick): ${describeErr(err)}`,
          );
          return;
        }
        this.log.warn(`getEvents cursor out of RPC retention window, cold-starting: ${describeErr(err)}`);
        res = await withRpcTimeout(
          server.getEvents({ ...baseFilter, startLedger: await this.coldStart(server) }),
          'getEvents',
        );
      }
    } else {
      res = await withRpcTimeout(
        server.getEvents({ ...baseFilter, startLedger: await this.coldStart(server) }),
        'getEvents',
      );
    }

    let advanced = 0;
    for (const ev of res.events) {
      advanced += await this.applyEvent(ev);
    }

    await this.prisma.indexerState.upsert({
      where: { id: 1 },
      update: { cursor: res.cursor },
      create: { id: 1, cursor: res.cursor },
    });
    if (res.events.length > 0) {
      this.log.log(`processed ${res.events.length} event(s), advanced ${advanced} order(s)`);
    }
  }

  private async coldStart(server: Server): Promise<number> {
    const latest = await withRpcTimeout(server.getLatestLedger(), 'getLatestLedger');
    return Math.max(1, latest.sequence - LOOKBACK_LEDGERS);
  }

  private async applyEvent(ev: { topic: any[]; value: any; contractId?: any }): Promise<number> {
    if (!ev.topic || ev.topic.length < 2) return 0;
    const toScVal = (t: any) =>
      typeof t === 'string' ? xdr.ScVal.fromXdr(t, 'base64') : t;

    let name: string;
    let tradeId: string;
    try {
      name = String(scValToNative(toScVal(ev.topic[0])));
      const tid = scValToNative(toScVal(ev.topic[1]));
      tradeId = tid instanceof Uint8Array ? Buffer.from(tid).toString('hex') : String(tid);
    } catch {
      return 0;
    }

    if (!(name in EVENT_STATUS) && name !== 'resolved') return 0;

    const order = await this.prisma.order.findUnique({ where: { tradeId } });
    if (!order) return 0;

    const evContractId = eventContractId(ev);
    if (!evContractId) {
      this.log.warn(
        `event missing contractId for order ${order.id} (tradeId ${tradeId}) — skipping (fail-closed)`,
      );
      return 0;
    }
    const expectedContractId = contractIdFor(order, this.cfg);
    if (evContractId !== expectedContractId) {
      this.log.warn(
        `event contract mismatch for order ${order.id} (tradeId ${tradeId}): expected ${expectedContractId}, got ${evContractId} — skipping`,
      );
      return 0;
    }

    if (NOT_YET_BOUND_ON_CHAIN.includes(order.status)) {
      const bound = await this.bindTradeToOrder(evContractId, order);
      if (!bound) return 0;
    }

    if (name === 'resolved') return this.applyResolvedEvent(ev, order, toScVal);
    if (name === 'disputed') return this.applyDisputedEvent(ev, order, toScVal);

    const target = EVENT_STATUS[name];

    if ((STATUS_BEFORE[target] as string[]).includes(order.status)) {

      let settledAt = new Date();
      let postSettleDeadline: bigint | null = null;
      if (target === 'RELEASED' || target === 'REFUNDED') {
        try {
          const onChain = await this.stellar.getTradeStatus(evContractId, order.tradeId);
          if (onChain && onChain.settledAt > 0) {
            settledAt = new Date(onChain.settledAt * 1000);
          }
          if (onChain?.postSettleDeadline) {
            postSettleDeadline = onChain.postSettleDeadline;
          }
        } catch {
        }
      }
      const extra: Record<string, any> =
        target === 'RELEASED' || target === 'REFUNDED'
          ? { settledAt, ...(postSettleDeadline === null ? {} : { postSettleDeadline }) }
          : {};
      const res = await this.prisma.order.updateMany({
        where: { id: order.id, status: { in: STATUS_BEFORE[target] as any[] } },
        data: { status: target as any, ...extra },
      });
      if (res.count === 0) return 0;

      await this.notifications.notifyOrderStatus(order as any, target);
      return 1;
    }
    return 0;
  }

  private async bindTradeToOrder(contractId: string, order: any): Promise<boolean> {
    const trade = await this.stellar.getTradeStatusStrict(contractId, order.tradeId);
    if (!trade) {
      this.log.warn(
        `order ${order.id} (tradeId ${order.tradeId}): event received but get_trade returned nothing — not advancing (fail-closed)`,
      );
      return false;
    }

    const mismatches = verifyTradeMatchesOrder(trade, order);
    if (mismatches.length === 0) return true;

    this.log.error(
      `order ${order.id} (tradeId ${order.tradeId}): REFUSING to bind — the on-chain trade does not match the order. ${mismatches.join(' | ')}`,
    );
    return false;
  }

  private async applyDisputedEvent(
    ev: { value: any; contractId?: any },
    order: { id: string; tradeId: string; status: string; disputeAt?: Date | null },
    toScVal: (t: any) => any,
  ): Promise<number> {
    let disputedBy: string | undefined;
    try {
      const val = scValToNative(toScVal(ev.value)) as { by?: unknown } | null;
      disputedBy = typeof val?.by === 'string' ? val.by : undefined;
    } catch {
      disputedBy = undefined;
    }

    if ((POST_SETTLE_TERMINAL as readonly string[]).includes(order.status)) {
      const contractId = eventContractId(ev) ?? this.cfg.escrowContractId;
      const onChain = await this.stellar.getTradeStatusStrict(contractId, order.tradeId);
      if (!onChain || onChain.status !== 'DISPUTED') {
        return 0;
      }

      const res = await this.prisma.order.updateMany({
        where: { id: order.id, status: { in: ['RELEASED', 'REFUNDED'] } },
        data: { status: 'DISPUTED', disputeAt: order.disputeAt ?? new Date() },
      });
      if (res.count === 0) return 0;
      await this.reconcileDisputeMetadata(order.id, disputedBy);
      await this.notifications.notifyOrderStatus(order as any, 'DISPUTED');
      return 1;
    }

    const target = 'DISPUTED';
    const res = await this.prisma.order.updateMany({
      where: { id: order.id, status: { in: STATUS_BEFORE[target] as any[] } },
      data: { status: target as any, disputeAt: order.disputeAt ?? new Date() },
    });
    if (res.count === 0) return 0;
    await this.reconcileDisputeMetadata(order.id, disputedBy);
    await this.notifications.notifyOrderStatus(order as any, target);
    return 1;
  }

  private async reconcileDisputeMetadata(orderId: string, by: string | undefined): Promise<void> {
    if (!by) return;
    const fresh = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!fresh) return;

    const actualRole = attributeDisputer(by, fresh.userAddress, fresh.lpWallet);
    if (actualRole === fresh.disputeBy) return;

    if (actualRole === 'resolver') {
      await this.prisma.order.updateMany({
        where: { id: orderId, resolverDisputed: false },
        data: { resolverDisputed: true },
      });
      this.log.log(
        `order ${orderId}: the resolver raised a dispute of its own; the ${fresh.disputeBy ?? 'absent'} filing is kept`,
      );
      return;
    }

    if (!fresh.disputeBy) return;

    const res = await this.prisma.order.updateMany({
      where: { id: orderId, disputeBy: fresh.disputeBy },
      data: { disputeBy: actualRole, disputeReason: null, disputeNote: null, disputeEvidenceUrl: null },
    });
    if (res.count > 0) {
      this.log.warn(
        `reconciled dispute metadata for order ${orderId}: stored disputeBy=${fresh.disputeBy} did not match the on-chain disputer (${actualRole}) — reason/note/evidence cleared`,
      );
    }
  }

  private async applyResolvedEvent(
    ev: { value: any; contractId?: any },
    order: { id: string; tradeId: string; status: string; userAddress: string; flow: string },
    toScVal: (t: any) => any,
  ): Promise<number> {
    let val: { released?: boolean; post_settle?: boolean };
    try {
      val = scValToNative(toScVal(ev.value)) as { released?: boolean; post_settle?: boolean };
    } catch {
      return 0;
    }

    if (typeof val?.released !== 'boolean') return 0;

    const contractId = eventContractId(ev) ?? this.cfg.escrowContractId;

    if (val.post_settle !== true) {
      let onChain;
      try {
        onChain = await this.stellar.getTradeStatus(contractId, order.tradeId);
      } catch {
        onChain = null;
      }
      const target = val.released ? 'RELEASED' : 'REFUNDED';

      const resolution = val.released ? 'released' : 'refunded';
      const settledAt =
        onChain && onChain.settledAt > 0 ? new Date(onChain.settledAt * 1000) : new Date();
      const latched = onChain?.postSettleDeadline
        ? { postSettleDeadline: onChain.postSettleDeadline }
        : {};
      const res = await this.prisma.order.updateMany({
        where: { id: order.id, status: { in: STATUS_BEFORE[target] as any[] } },
        data: { status: target as any, settledAt, resolution, ...latched },
      });
      if (res.count === 0) return 0;
      await this.accrueDisputeLossIfApplicable(order, resolution);
      await this.notifications.notifyOrderStatus(order as any, target);
      return 1;
    }

    const settled = await this.stellar.getTradeStatusStrict(contractId, order.tradeId);
    if (!settled || !(POST_SETTLE_TERMINAL as readonly string[]).includes(settled.status)) {
      return 0;
    }
    const finalStatus = settled.status;

    const resolution = finalStatus === 'RELEASED' ? 'released' : 'refunded';
    const res = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'DISPUTED' },
      data: { status: finalStatus as any, resolution },
    });
    if (res.count === 0) return 0;
    await this.accrueDisputeLossIfApplicable(order, resolution);
    await this.notifications.notifyOrderStatus(order as any, finalStatus);
    return 1;
  }

  private async accrueDisputeLossIfApplicable(
    order: { id: string; userAddress: string; flow: string },
    resolution: 'released' | 'refunded',
  ): Promise<void> {
    if (providerLostDispute(order.flow, resolution)) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const flipped = await tx.order.updateMany({
            where: { id: order.id, disputeLossAccrued: false },
            data: { disputeLossAccrued: true },
          });
          if (flipped.count === 0) return;
          const fresh = await tx.order.findUnique({ where: { id: order.id }, select: { lpId: true } });
          if (!fresh?.lpId) return;
          await tx.lp.update({
            where: { id: fresh.lpId },
            data: { disputesLost: { increment: 1 } },
          });
        });
      } catch (e) {
        this.log.warn(
          `recording a provider dispute loss failed for order ${order.id}: ${e instanceof Error ? e.message : String(e)} — status indexing continues unaffected`,
        );
      }
      return;
    }

    if (!userLostDispute(order.flow, resolution)) return;
    try {
      await this.userReputation.recordDisputeLost(order.userAddress, order.id);
    } catch (e) {
      this.log.warn(
        `recordDisputeLost failed for order ${order.id} (userAddress ${order.userAddress}): ${e instanceof Error ? e.message : String(e)} — status indexing continues unaffected`,
      );
    }
  }
}

function eventContractId(ev: { contractId?: any }): string | undefined {
  const c = ev.contractId;
  if (typeof c === 'string') return c;
  if (c && typeof c.contractId === 'function') return c.contractId();
  return undefined;
}

function isRetentionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === -32600 && typeof e.message === 'string' && /ledger range/i.test(e.message);
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}
