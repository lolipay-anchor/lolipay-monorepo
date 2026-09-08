import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { NotificationService } from '../notification/notification.service';
import { StellarReadService, withRpcTimeout } from '../stellar/stellar-read.service';
import { contractIdFor } from '../order/order.params';
import { verifyTradeMatchesOrder, notYetBoundOnChain } from '../order/trade-binding';
import { userLostDispute, providerLostDispute } from '../reputation/dispute-outcome';
import { UserReputationService } from '../reputation/user-reputation.service';
import { recordAudit } from '../admin/admin-audit';
import { Prisma } from '../generated/prisma/client';

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

const STATUS_BEFORE: Record<string, string[]> = {
  FUNDED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'EXPIRED', 'CANCELLED'],
  FIAT_PAID: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'EXPIRED', 'CANCELLED'],
  DISPUTED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'EXPIRED', 'CANCELLED'],
  RELEASED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'],
  REFUNDED: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'EXPIRED', 'CANCELLED'],
};

export const LOOKBACK_LEDGERS = 17280;
export const LEDGER_SECONDS = 5;

function settlementHashOf(ev: { txHash?: string }): string | undefined {
  const h = ev.txHash;
  return typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h) ? h.toLowerCase() : undefined;
}

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

  private async applyEvent(ev: { id?: string; topic: any[]; value: any; contractId?: any; txHash?: string }): Promise<number> {
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

    if (notYetBoundOnChain(order.status)) {
      const bound = await this.bindTradeToOrder(evContractId, order);
      if (!bound) return 0;
    }

    if (name === 'resolved') return this.applyResolvedEvent(ev, order, toScVal);
    if (name === 'disputed') return this.applyDisputedEvent(ev, order, toScVal);

    const target = EVENT_STATUS[name];
    const hash = settlementHashOf(ev);
    const settling = target === 'RELEASED' || target === 'REFUNDED';

    if (settling && hash && order.status === target && !order.settlementTxHash) {
      return this.backfillSettlementHash(order, target, hash);
    }

    if ((STATUS_BEFORE[target] as string[]).includes(order.status)) {

      let extra: Record<string, any> = {};
      if (target === 'RELEASED' || target === 'REFUNDED') {
        let onChain;
        try {
          onChain = await this.stellar.getTradeStatus(evContractId, order.tradeId);
        } catch {
          onChain = null;
        }
        if (!onChain?.postSettleDeadline) {
          this.log.warn(
            `settlement of ${order.id} recorded without a post-settlement deadline: the chain reported none`,
          );
        }
        extra = {
          settledAt: onChain && onChain.settledAt > 0 ? new Date(onChain.settledAt * 1000) : new Date(),
          ...(onChain?.postSettleDeadline ? { postSettleDeadline: onChain.postSettleDeadline } : {}),
          ...(hash ? { settlementTxHash: hash } : {}),
        };
      }
      const res = await this.prisma.order.updateMany({
        where: { id: order.id, status: { in: STATUS_BEFORE[target] as any[] } },
        data: { status: target as any, ...extra },
      });
      if (res.count === 0) {
        if (!settling || !hash) return 0;
        const fresh = await this.prisma.order.findUnique({ where: { id: order.id } });
        if (fresh && fresh.status === target && !fresh.settlementTxHash) {
          return this.backfillSettlementHash(fresh, target, hash);
        }
        if (fresh && fresh.status !== target) {
          this.log.warn(`settlement hash for ${order.id} not recorded: row moved to ${fresh.status} before the ${target} event landed`);
        }
        return 0;
      }

      await this.notifySafely(order, target);
      return 1;
    }
    return 0;
  }

  private async backfillSettlementHash(order: any, target: string, hash: string): Promise<number> {
    const filled = await this.prisma.order.updateMany({
      where: { id: order.id, status: target as any, settlementTxHash: null },
      data: { settlementTxHash: hash },
    });
    if (filled.count > 0) {
      await this.notifySafely(order, target);
    } else {
      this.log.warn(`settlement hash backfill for ${order.id} matched no row at ${target} with a null hash`);
    }
    return 0;
  }

  private async notifySafely(order: any, status: string): Promise<void> {
    try {
      await this.notifications.notifyOrderStatus(order, status);
    } catch (err) {
      this.log.warn(`notification for order ${order.id} at ${status} failed: ${describeErr(err)}`);
    }
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
    order: { id: string; tradeId: string; status: string; disputeAt?: Date | null; disputeBy?: string | null },
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
        data: { status: 'DISPUTED', disputeAt: disputeStampFor(order) },
      });
      if (res.count === 0) return 0;
      await this.reconcileDisputeMetadata(order.id, disputedBy);
      await this.notifySafely(order, 'DISPUTED');
      return 1;
    }

    const target = 'DISPUTED';
    const res = await this.prisma.order.updateMany({
      where: { id: order.id, status: { in: STATUS_BEFORE[target] as any[] } },
      data: { status: target as any, disputeAt: disputeStampFor(order) },
    });
    if (res.count === 0) return 0;
    await this.reconcileDisputeMetadata(order.id, disputedBy);
    await this.notifySafely(order, target);
    return 1;
  }

  private async reconcileDisputeMetadata(orderId: string, by: string | undefined): Promise<void> {
    if (!by) return;
    const fresh = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!fresh) return;

    const actualRole = attributeDisputer(by, fresh.userAddress, fresh.lpWallet);

    await this.prisma.order.updateMany({
      where: { id: orderId },
      data: {
        onChainDisputedBy: by,
        ...(actualRole === 'resolver' ? { resolverDisputed: true } : {}),
      },
    });

    if (fresh.disputeBy && actualRole !== fresh.disputeBy) {
      this.log.warn(
        `order ${orderId}: the chain says ${by} raised the dispute (${actualRole}) but the filing on record is from ${fresh.disputeBy} — both are kept, and the console shows the divergence`,
      );
    }
  }

  private async applyResolvedEvent(
    ev: { id?: string; value: any; contractId?: any; txHash?: string },
    order: { id: string; tradeId: string; status: string; userAddress: string; flow: string },
    toScVal: (t: any) => any,
  ): Promise<number> {
    const eventId = ev.id;
    if (!eventId) {
      throw new Error(
        `resolver verdict for order ${order.id} arrived without an RPC event id: refusing to apply a verdict this indexer cannot recognise again`,
      );
    }

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
      const hash = settlementHashOf(ev);
      const res = await this.prisma.$transaction(async (tx) => {
        if (!(await this.claimEvent(tx, eventId))) return { replay: true, written: 0 };
        const written = await tx.order.updateMany({
          where: {
            id: order.id,
            OR: [
              { status: { in: STATUS_BEFORE[target] as any[] }, resolution: null },
              { status: target as any, resolution: null },
            ],
          },
          data: { status: target as any, settledAt, resolution, ...latched, ...(hash ? { settlementTxHash: hash } : {}) },
        });
        if (written.count > 0) await this.closeDisputeRound(tx, order.id, contractId);
        return { replay: false, written: written.count };
      });
      if (res.replay) {
        this.log.debug(`resolver verdict ${eventId} on ${order.id} has already been applied — ignoring the replay`);
        return 0;
      }
      if (res.written === 0) {
        this.log.warn(`resolver verdict on ${order.id} matched no row: status ${order.status}, resolution already recorded`);
        return 0;
      }
      await this.accrueDisputeLossIfApplicable(order, resolution);
      await this.notifySafely(order, target);
      return 1;
    }

    const settled = await this.stellar.getTradeStatusStrict(contractId, order.tradeId);
    if (!settled) return 0;
    if (!(POST_SETTLE_TERMINAL as readonly string[]).includes(settled.status)) {
      await this.claimEvent(this.prisma, eventId);
      this.log.warn(
        `post-settlement verdict ${eventId} on ${order.id} arrived while the chain reports ${settled.status}: a later round is open, so this verdict is recorded as decided and will not be applied`,
      );
      return 0;
    }
    const finalStatus = settled.status;

    const verdict = val.released ? 'released' : 'refunded';
    const res = await this.prisma.$transaction(async (tx) => {
      if (!(await this.claimEvent(tx, eventId))) return { replay: true, written: 0 };
      const written = await tx.order.updateMany({
        where: { id: order.id },
        data: {
          status: finalStatus as any,
          resolution: verdict,
          ...(typeof settled.liabilityEstablished === 'boolean' && settled.slashDeadline !== undefined
            ? {
                liabilityEstablished: settled.liabilityEstablished,
                slashDeadline: settled.slashDeadline,
              }
            : {}),
        },
      });
      if (written.count > 0) await this.closeDisputeRound(tx, order.id, contractId);
      return { replay: false, written: written.count };
    });
    if (res.replay) {
      this.log.debug(`post-settlement verdict ${eventId} on ${order.id} has already been applied — ignoring the replay`);
      return 0;
    }
    if (res.written === 0) {
      this.log.warn(`post-settlement verdict on ${order.id} matched no row: the order was deleted between the read and the write`);
      return 0;
    }
    await this.accrueDisputeLossIfApplicable(order, verdict);
    await this.notifySafely(order, finalStatus);
    return 1;
  }

  private async claimEvent(tx: Prisma.TransactionClient, eventId: string): Promise<boolean> {
    const claimed = await tx.indexedEvent.createMany({ data: [{ id: eventId }], skipDuplicates: true });
    return claimed.count > 0;
  }

  private async closeDisputeRound(tx: Prisma.TransactionClient, orderId: string, contractId: string): Promise<void> {
    const open = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        disputeBy: true,
        disputeReason: true,
        disputeNote: true,
        disputeEvidenceUrl: true,
        disputeAt: true,
        onChainDisputedBy: true,
      },
    });
    if (!open || (!open.disputeBy && !open.onChainDisputedBy)) return;
    const closed = await tx.order.updateMany({
      where: { id: orderId, OR: [{ disputeBy: { not: null } }, { onChainDisputedBy: { not: null } }] },
      data: { disputeBy: null, disputeReason: null, disputeNote: null, onChainDisputedBy: null, resolverDisputed: false, disputeClosedAt: new Date() },
    });
    if (closed.count !== 1) return;
    await recordAudit(tx as any, {
      actorAddress: contractId,
      action: 'order.disputeRoundClosed',
      targetType: 'Order',
      targetId: orderId,
      before: {
        disputeBy: open.disputeBy,
        disputeReason: open.disputeReason,
        disputeNote: open.disputeNote,
        disputeEvidenceUrl: open.disputeEvidenceUrl,
        disputeAt: open.disputeAt,
        onChainDisputedBy: open.onChainDisputedBy,
      },
      after: null,
    });
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

function disputeStampFor(order: { disputeAt?: Date | null; disputeBy?: string | null }): Date {
  return order.disputeBy ? (order.disputeAt ?? new Date()) : new Date();
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
