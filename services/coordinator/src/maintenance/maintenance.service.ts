import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { RefundSignerService } from '../stellar/refund-signer.service';
import { AppConfigService } from '../config/app-config.service';
import { NotificationService } from '../notification/notification.service';
import { contractIdFor } from '../order/order.params';
import { ATTEST_GRACE_SECS, refundOpensAt } from '../order/dispute.util';
import { Alert, AlertsService } from '../monitoring/alerts.service';
import { OutboxService } from '../outbox/outbox.service';
import { verifyTradeMatchesOrder } from '../order/trade-binding';
import { settlementFieldsFrom } from '../order/order-status.service';

const STALE_ORDER_SWEEP_GRACE_MS = 60_000;
const AUTO_REFUND_BATCH_SIZE = 20;
const DIVERGENCE_SCAN_LIMIT = 500;

const ORPHAN_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;


@Injectable()
export class MaintenanceService {
  private readonly log = new Logger('Maintenance');

  private warnedSignerNotConfigured = false;

  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private refundSigner: RefundSignerService,
    private cfg: AppConfigService,
    private notifications: NotificationService,
    private alerts: AlertsService,
    private outbox: OutboxService,
  ) {}

  private readonly inFlight = new Set<string>();

  private async once(name: string, run: () => Promise<unknown>): Promise<void> {
    if (this.inFlight.has(name)) {
      this.log.warn(`${name} is still running from a previous tick — skipping this one`);
      return;
    }
    this.inFlight.add(name);
    try {
      await run();
    } finally {
      this.inFlight.delete(name);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async alertOnEscrowDivergence(): Promise<void> {
    await this.once('alertOnEscrowDivergence', () => this.run_alertOnEscrowDivergence());
  }

  private async run_alertOnEscrowDivergence(): Promise<void> {
    const config = await this.prisma.config.findUnique({ where: { id: 1 } });
    const reconcilerWillAct = Boolean(config?.autoRefund) && this.refundSigner.isConfigured;
    let candidates: { id: string; tradeId: string; contractId: string | null; status: string }[];
    try {
      candidates = await this.prisma.order.findMany({
        where: { status: { in: ['CANCELLED', 'EXPIRED'] } },
        select: { id: true, tradeId: true, contractId: true, status: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: DIVERGENCE_SCAN_LIMIT,
      });
    } catch (err) {
      this.log.error(`alertOnEscrowDivergence: could not read orders: ${errMsg(err)}`);
      return;
    }

    const incomplete = new Set<string>();
    const found: Alert[] = [];
    if (candidates.length >= DIVERGENCE_SCAN_LIMIT) {
      incomplete.add('escrow_divergence');
      found.push({
        key: 'escrow_divergence:overflow',
        fingerprint: 'at-limit',
        urgency: 'urgent',
        text: `at least ${DIVERGENCE_SCAN_LIMIT} cancelled or expired orders are within the divergence window — the scan is truncated and nothing in this family will be reported as cleared until it is not`,
      });
    }
    for (const o of candidates) {
      const contractId = contractIdFor(o, this.cfg);
      let onChain;
      try {
        onChain = await this.stellar.getTradeStatusStrict(contractId, o.tradeId);
      } catch (err) {
        this.log.warn(`alertOnEscrowDivergence: order ${o.id} read failed: ${errMsg(err)}`);
        incomplete.add('escrow_divergence');
        continue;
      }
      if (!onChain) continue;
      if (onChain.status === 'REFUNDED') continue;
      if (onChain.status === 'FUNDED' && reconcilerWillAct) continue;
      found.push({
        key: `escrow_divergence:${o.id}`,
        fingerprint: onChain.status,
        urgency: 'urgent',
        text: `order ${o.id} (trade ${o.tradeId}) is ${o.status} off chain but ${onChain.status} on chain — a human must look at this`,
      });
    }

    await this.alerts.raise(['escrow_divergence'], found, incomplete);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStaleOrders(): Promise<void> {
    await this.once('expireStaleOrders', () => this.run_expireStaleOrders());
  }

  private async run_expireStaleOrders() {
    let ledgerSeenAt: Date;
    try {
      ledgerSeenAt = await this.stellar.latestLedgerCloseTime();
    } catch (err) {
      this.log.warn(`expireStaleOrders: cannot tell which ledger the RPC has seen, expiring nothing: ${String(err)}`);
      return;
    }
    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'] },
        expiresAt: { lt: new Date(Math.min(Date.now(), ledgerSeenAt.getTime()) - STALE_ORDER_SWEEP_GRACE_MS) },
      },
      select: {
        id: true,
        tradeId: true,
        contractId: true,
        status: true,
        userAddress: true,
        lpWallet: true,
        flow: true,
        usdcAmount: true,
        fiatAmount: true,
        fiatCurrency: true,
        platformFeeBps: true,
        lpFeeBps: true,
        platformWallet: true,
        payDeadline: true,
        confirmDeadline: true,
        disputeDeadline: true,
      },
      take: 200,
    });

    let expired = 0;
    for (const o of candidates) {
      try {
        const onChain = await this.stellar.getTradeStatusStrict(contractIdFor(o, this.cfg), o.tradeId);
        if (onChain) {
          const mismatches = verifyTradeMatchesOrder(onChain, o as any);
          if (mismatches.length === 0) continue;
          this.log.warn(
            `expireStaleOrders: trade ${o.tradeId} exists on chain but is not order ${o.id}: ${mismatches.join('; ')}`,
          );
        }
      } catch {
        continue;
      }

      try {
        const res = await this.prisma.order.updateMany({
          where: {
            id: o.id,
            status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'] },
          },
          data: { status: 'EXPIRED' },
        });
        if (res.count > 0) {
          expired += res.count;

          await this.notifications.notifyOrderStatus(o as any, 'MATCHED_EXPIRED');
        }
      } catch (err) {
        this.log.warn(`expireStaleOrders: order ${o.id} failed: ${errMsg(err)}`);
      }
    }
    if (expired > 0) this.log.log(`expired ${expired} stale pre-chain order(s)`);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async pruneOldQuotes(): Promise<void> {
    await this.once('pruneOldQuotes', () => this.run_pruneOldQuotes());
  }

  private async run_pruneOldQuotes() {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const res = await this.prisma.quote.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    if (res.count > 0) this.log.log(`pruned ${res.count} expired quote(s)`);

    const spent = await this.prisma.walletLinkChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (spent.count > 0) this.log.log(`pruned ${spent.count} spent wallet-link challenge(s)`);

    const anchor = await this.prisma.consumedChallenge.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (anchor.count > 0) this.log.log(`pruned ${anchor.count} spent SEP-10 challenge(s)`);

    try {
      await this.outbox.prune();
    } catch (err) {
      this.log.warn(`pruning delivered outbox messages failed: ${errMsg(err)}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoRefundExpired(): Promise<void> {
    await this.once('autoRefundExpired', () => this.run_autoRefundExpired());
  }

  private async run_autoRefundExpired() {
    const config = await this.prisma.config.findUnique({ where: { id: 1 } });
    if (!config?.autoRefund) return;

    if (!this.refundSigner.isConfigured) {
      if (!this.warnedSignerNotConfigured) {
        this.log.warn(
          'autoRefundExpired: Config.autoRefund is enabled but REFUND_SIGNER_SECRET is not configured — skipping (fail-closed)',
        );
        this.warnedSignerNotConfigured = true;
      }
      return;
    }
    const sourceAddr = this.refundSigner.publicKey;
    if (!sourceAddr) return;

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const candidates = await this.prisma.order.findMany({
      where: {
        status: 'FUNDED',
        OR: [
          { confirmDeadline: { lt: nowSecs } },
          { flow: 'TOP_UP', payDeadline: { lt: nowSecs - ATTEST_GRACE_SECS } },
        ],
      },
      select: { id: true, tradeId: true, contractId: true },
      take: AUTO_REFUND_BATCH_SIZE,
    });

    let refunded = 0;
    for (const o of candidates) {
      try {
        const contractId = contractIdFor(o, this.cfg);

        let onChain;
        try {
          onChain = await this.stellar.getTradeStatusStrict(contractId, o.tradeId);
        } catch (err) {
          this.log.warn(
            `autoRefundExpired: order ${o.id} on-chain status read failed, skipping: ${errMsg(err)}`,
          );
          continue;
        }
        if (!onChain || onChain.status !== 'FUNDED') continue;

        const result = await this.refundSigner.submitRefund(contractId, o.tradeId);

        if (result.status !== 'SUCCESS') {
          this.log.warn(
            `autoRefundExpired: order ${o.id} refund tx did not succeed (status=${result.status}, hash=${result.hash})`,
          );
          continue;
        }

        let settlement: Record<string, unknown> = {};
        try {
          const after = await this.stellar.getTradeStatusStrict(contractId, o.tradeId);
          if (after) settlement = settlementFieldsFrom(after);
        } catch (err) {
          this.log.warn(
            `autoRefundExpired: order ${o.id} settled but its deadline could not be read back: ${errMsg(err)}`,
          );
        }

        const advanced = await this.prisma.order.updateMany({
          where: { id: o.id, status: 'FUNDED' },
          data: { status: 'REFUNDED', settledAt: new Date(), settlementTxHash: result.hash, ...settlement },
        });
        if (advanced.count > 0) {
          refunded += 1;
          this.log.log(`autoRefundExpired: refunded order ${o.id} (hash=${result.hash})`);

          try {
            const fresh = await this.prisma.order.findUnique({ where: { id: o.id } });
            if (fresh) await this.notifications.notifyOrderStatus(fresh as any, 'REFUNDED');
          } catch (err) {
            this.log.warn(`autoRefundExpired: notify failed for order ${o.id}: ${errMsg(err)}`);
          }
        }
      } catch (err) {
        this.log.warn(`autoRefundExpired: order ${o.id} failed: ${errMsg(err)}`);
      }
    }
    if (refunded > 0) this.log.log(`autoRefundExpired: refunded ${refunded} order(s) this tick`);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileOrphanedEscrows(): Promise<void> {
    await this.once('reconcileOrphanedEscrows', () => this.run_reconcileOrphanedEscrows());
  }

  private async run_reconcileOrphanedEscrows() {
    const config = await this.prisma.config.findUnique({ where: { id: 1 } });
    if (!config?.autoRefund) return;
    if (!this.refundSigner.isConfigured) return;

    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: ['CANCELLED', 'EXPIRED'] },
        createdAt: { gt: new Date(Date.now() - ORPHAN_LOOKBACK_MS) },
      },
      select: {
        id: true,
        tradeId: true,
        contractId: true,
        status: true,
        flow: true,
        payDeadline: true,
        confirmDeadline: true,
      },
      take: AUTO_REFUND_BATCH_SIZE,
    });

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    let recovered = 0;

    for (const o of candidates) {
      const contractId = contractIdFor(o, this.cfg);

      let onChain;
      try {
        onChain = await this.stellar.getTradeStatusStrict(contractId, o.tradeId);
      } catch (err) {
        this.log.warn(`reconcileOrphanedEscrows: order ${o.id} read failed, skipping: ${errMsg(err)}`);
        continue;
      }
      if (!onChain) continue;

      if (onChain.status !== 'FUNDED') continue;

      if (refundOpensAt(o) >= nowSecs) continue;

      try {
        const result = await this.refundSigner.submitRefund(contractId, o.tradeId);
        if (result.status !== 'SUCCESS') {
          this.log.warn(
            `reconcileOrphanedEscrows: order ${o.id} refund did not succeed (status=${result.status}, hash=${result.hash})`,
          );
          continue;
        }
        recovered += 1;
        this.log.log(
          `reconcileOrphanedEscrows: recovered a funded escrow orphaned by a ${o.status} order ${o.id} (hash=${result.hash})`,
        );
      } catch (err) {
        this.log.warn(`reconcileOrphanedEscrows: order ${o.id} failed: ${errMsg(err)}`);
      }
    }

    if (recovered > 0) {
      this.log.log(`reconcileOrphanedEscrows: recovered ${recovered} orphaned escrow(s) this tick`);
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
