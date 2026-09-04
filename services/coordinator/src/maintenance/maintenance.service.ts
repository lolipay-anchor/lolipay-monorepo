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
import { platformWalletRemedy } from '../config/platform-wallet-remedy';

const STALE_ORDER_SWEEP_GRACE_MS = 60_000;
const AUTO_REFUND_BATCH_SIZE = 20;
const DIVERGENCE_SCAN_LIMIT = 500;

const ORPHAN_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
export const RECONCILER_PERIOD_SECS = 600;
export const MAX_WALK_PERIODS = 12;

function refundablePoolWhere(nowSecs: bigint) {
  return {
    status: { in: ['CANCELLED', 'EXPIRED'] as ('CANCELLED' | 'EXPIRED')[] },
    settlementTxHash: null,
    settledAt: null,
    createdAt: { gt: new Date(Date.now() - ORPHAN_LOOKBACK_MS) },
    OR: [{ confirmDeadline: { lt: nowSecs } }, { flow: 'TOP_UP' as const, payDeadline: { lt: nowSecs - ATTEST_GRACE_SECS } }],
  };
}


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
    let autoRefund = false;
    let configReadable = true;
    try {
      autoRefund = Boolean((await this.prisma.config.findUnique({ where: { id: 1 } }))?.autoRefund);
    } catch (err) {
      configReadable = false;
      this.log.warn(`alertOnEscrowDivergence: config read failed, assuming the refund reconciler will not act: ${errMsg(err)}`);
    }
    const orphanCutoff = Date.now() - ORPHAN_LOOKBACK_MS;
    const nowSecs = Math.floor(Date.now() / 1000);
    let candidates: {
      id: string;
      tradeId: string;
      contractId: string | null;
      status: string;
      createdAt: Date;
      flow: string;
      payDeadline: bigint;
      confirmDeadline: bigint;
    }[];
    try {
      candidates = await this.prisma.order.findMany({
        where: { status: { in: ['CANCELLED', 'EXPIRED'] } },
        select: { id: true, tradeId: true, contractId: true, status: true, createdAt: true, flow: true, payDeadline: true, confirmDeadline: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DIVERGENCE_SCAN_LIMIT,
      });
    } catch (err) {
      this.log.error(`alertOnEscrowDivergence: could not read orders: ${errMsg(err)}`);
      await this.alerts.raise(
        ['escrow_divergence'],
        [{ key: 'escrow_divergence:unreadable', fingerprint: 'unreadable', urgency: 'urgent', text: `cancelled and expired orders could not be compared with the escrow because the order query failed: ${errMsg(err)}` }],
        new Set(['escrow_divergence']),
      );
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
        text: `at least ${DIVERGENCE_SCAN_LIMIT} cancelled or expired orders were found by the divergence scan, which is truncated there, and nothing in this family will be reported as cleared until it is not`,
      });
    }
    let poolSize = candidates.length;
    if (configReadable && autoRefund && this.refundSigner.isConfigured) {
      try {
        poolSize = await this.prisma.order.count({ where: refundablePoolWhere(BigInt(nowSecs)) });
      } catch (err) {
        this.log.warn(`alertOnEscrowDivergence: could not size the reconciler pool, assuming the scan's width: ${errMsg(err)}`);
        incomplete.add('escrow_divergence');
        found.push({
          key: 'escrow_divergence:pool-unsized',
          fingerprint: 'pool-unsized',
          urgency: 'urgent',
          text: `the reconciler pool could not be counted, so the allowance before a funded orphan is called missed is a guess from the scan width: ${errMsg(err)}`,
        });
      }
    }
    const walkPeriods = Math.min(Math.ceil(poolSize / AUTO_REFUND_BATCH_SIZE) + 1, MAX_WALK_PERIODS);
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
      try {
      if (!onChain) continue;
      if (onChain.status === 'REFUNDED') continue;
      if (onChain.status === 'FUNDED') {
        const inLookback = o.createdAt.getTime() > orphanCutoff;
        const refundAt = Number(refundOpensAt(o));
        const [tag, why] = !configReadable
          ? ['config-unknown', 'the Config row could not be read, so whether the reconciler will act is unknown']
          : !autoRefund
            ? ['off', 'Config.autoRefund is off']
            : !this.refundSigner.isConfigured
              ? ['no-signer', 'no refund signer is configured']
              : !inLookback
                ? ['old', 'it is older than the reconciler lookback, so nothing automatic will ever see it']
                : nowSecs > refundAt + walkPeriods * RECONCILER_PERIOD_SECS
                  ? ['missed', `the refund instant passed more than ${walkPeriods} reconciler periods ago, more than this alert allows for a walk of the pool, and the escrow is still funded, so the reconciler did not act`]
                  : ['reconciler', 'the refund reconciler will return it on its next pass'];
        found.push({
          key: `escrow_divergence:${o.id}`,
          fingerprint: `FUNDED:${tag}`,
          urgency: tag === 'reconciler' ? 'routine' : 'urgent',
          text: `order ${o.id} (trade ${o.tradeId}) is ${o.status} off chain but FUNDED on chain: ${why}; refund() is permissionless once the refund instant has passed (opens at ${new Date(refundAt * 1000).toISOString()}) and returns the USDC to the usdc_provider, ${o.flow === 'WITHDRAW' ? 'the user' : 'the provider'}`,
        });
        continue;
      }
      found.push({
        key: `escrow_divergence:${o.id}`,
        fingerprint: onChain.status,
        urgency: 'urgent',
        text: `order ${o.id} (trade ${o.tradeId}) is ${o.status} off chain but ${onChain.status} on chain — a human must look at this`,
      });
      } catch (err) {
        this.log.warn(`alertOnEscrowDivergence: order ${o.id} could not be described: ${errMsg(err)}`);
        found.push({
          key: `escrow_divergence:${o.id}`,
          fingerprint: `${onChain?.status ?? 'unknown'}:undescribed`,
          urgency: 'urgent',
          text: `order ${o.id} (trade ${o.tradeId}) is ${o.status} off chain but ${onChain?.status ?? 'unknown'} on chain and its alert could not be composed: ${errMsg(err)}`,
        });
      }
    }

    await this.alerts.raise(['escrow_divergence'], found, incomplete);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async alertOnEscrowConfigDrift(): Promise<void> {
    await this.once('alertOnEscrowConfigDrift', () => this.run_alertOnEscrowConfigDrift());
  }

  private async run_alertOnEscrowConfigDrift(): Promise<void> {
    const found: Alert[] = [];
    const incomplete = new Set<string>();
    try {
      const row = await this.prisma.config.findUnique({ where: { id: 1 } });
      if (!row) throw new Error('the Config row is missing');
      const chain = await this.stellar.readEscrowPlatformDefaults(this.cfg.escrowContractId);
      if (row.platformFeeBps !== chain.platformFeeBps) {
        found.push({
          key: 'escrow_config_drift:platformFeeBps',
          fingerprint: `${row.platformFeeBps}:${chain.platformFeeBps}`,
          urgency: 'urgent',
          text: `Config.platformFeeBps (${row.platformFeeBps}) differs from the escrow contract default_platform_fee_bps (${chain.platformFeeBps}); create_trade refuses every funding until the row is patched to match`,
        });
      }
      if (row.platformWallet !== chain.platformWallet) {
        found.push({
          key: 'escrow_config_drift:platformWallet',
          fingerprint: `${row.platformWallet}:${chain.platformWallet}`,
          urgency: 'urgent',
          text: `Config.platformWallet (${row.platformWallet}) differs from the escrow contract default_platform_wallet (${chain.platformWallet}), which the contract will not let anyone change; create_trade refuses every funding ${platformWalletRemedy(chain.platformWallet)}`,
        });
      }
    } catch (err) {
      this.log.warn(`alertOnEscrowConfigDrift: could not compare the row with the contract: ${errMsg(err)}`);
      incomplete.add('escrow_config_drift');
      found.push({
        key: 'escrow_config_drift:unreadable',
        fingerprint: 'unreadable',
        urgency: 'urgent',
        text: `Config.platformFeeBps and platformWallet are unchecked against the escrow contract because the comparison could not run: ${errMsg(err)}`,
      });
    }
    await this.alerts.raise(['escrow_config_drift'], found, incomplete);
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

  private orphanCursor: { createdAt: Date; id: string } | null = null;

  private async run_reconcileOrphanedEscrows() {
    const config = await this.prisma.config.findUnique({ where: { id: 1 } });
    if (!config?.autoRefund) return;
    if (!this.refundSigner.isConfigured) return;

    const nowSecs = BigInt(Math.floor(Date.now() / 1000));
    const after = this.orphanCursor;
    const candidates = await this.prisma.order.findMany({
      where: {
        ...refundablePoolWhere(nowSecs),
        ...(after ? { AND: [{ OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] } : {}),
      },
      select: {
        id: true,
        tradeId: true,
        contractId: true,
        status: true,
        flow: true,
        payDeadline: true,
        confirmDeadline: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: AUTO_REFUND_BATCH_SIZE,
    });
    const last = candidates[candidates.length - 1];
    this.orphanCursor = candidates.length === AUTO_REFUND_BATCH_SIZE && last ? { createdAt: last.createdAt, id: last.id } : null;

    let recovered = 0;

    for (const o of candidates) {
      if (refundOpensAt(o) >= nowSecs) continue;
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

      try {
        const result = await this.refundSigner.submitRefund(contractId, o.tradeId);
        if (result.status !== 'SUCCESS') {
          this.log.warn(
            `reconcileOrphanedEscrows: order ${o.id} refund did not succeed (status=${result.status}, hash=${result.hash})`,
          );
          continue;
        }
        recovered += 1;
        await this.prisma.$transaction([
          this.prisma.order.updateMany({ where: { id: o.id, settlementTxHash: null }, data: { settlementTxHash: result.hash } }),
          this.prisma.order.updateMany({ where: { id: o.id, settledAt: null }, data: { settledAt: new Date() } }),
        ]);
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
