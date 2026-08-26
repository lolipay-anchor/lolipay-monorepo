import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { Alert, AlertsService, Urgency } from './alerts.service';
import { OutboxService } from '../outbox/outbox.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import {
  ALERT_SAMPLE_LIMIT,
  DISPUTE_STALE_DAYS,
  SLASH_SCAN_LIMIT,
  slashCandidatesWhere,
  fiatPaymentOverdueWhere,
  nowSeconds,
  openDisputesWhere,
  releaseOverdueWhere,
} from './monitoring.conditions';

const INDEXER_LAG_ALERT_SECONDS = 120;

export const MONITORING_ALERT_SCOPE = [
  'open_dispute',
  'release_overdue',
  'fiat_payment_overdue',
  'indexer_stalled',
  'delivery_failing',
  'slash_window_open',
];

@Injectable()
export class MonitoringService {
  private readonly log = new Logger('Monitoring');
  constructor(
    private prisma: PrismaService,
    private alerts: AlertsService,
    private outbox: OutboxService,
    private stellar: StellarReadService,
    private cfg: AppConfigService,
  ) {}

  async slashWindowAlerts(
    now: Date = new Date(),
    incomplete: Set<string> = new Set(),
  ): Promise<Alert[]> {
    const candidates = await this.prisma.order.findMany({
      where: slashCandidatesWhere(now),
      select: { id: true, tradeId: true, contractId: true, usdcAmount: true },
      orderBy: [{ settledAt: 'asc' }, { id: 'asc' }],
      take: SLASH_SCAN_LIMIT,
    });

    const nowSecs = BigInt(Math.floor(now.getTime() / 1000));
    const out: Alert[] = [];

    if (candidates.length >= SLASH_SCAN_LIMIT) {
      incomplete.add('slash_window_open');
      out.push({
        key: 'slash_window_open:overflow',
        fingerprint: 'at-limit',
        urgency: 'urgent',
        text: `at least ${SLASH_SCAN_LIMIT} settled trades are in scope for recovery — the scan is truncated and nothing in this family will be reported as cleared until it is not`,
      });
    }
    for (const o of candidates) {
      const contractId = o.contractId ?? this.cfg.escrowContractId;
      let chain;
      try {
        chain = await this.stellar.getTradeStatusStrict(contractId, o.tradeId);
      } catch {
        incomplete.add('slash_window_open');
        continue;
      }
      if (!chain?.liabilityEstablished) continue;
      const deadline = chain.slashDeadline ?? 0n;
      if (deadline === 0n || nowSecs > deadline) continue;

      let recovered = 0n;
      try {
        recovered = await this.stellar.getSlashedSoFar(o.tradeId);
      } catch {
        incomplete.add('slash_window_open');
        continue;
      }
      if (recovered >= o.usdcAmount) continue;

      const minutesLeft = Number(deadline - nowSecs) / 60;
      out.push({
        key: `slash_window_open:${o.id}`,
        fingerprint: bucketOf(minutesLeft),
        urgency: 'urgent',
        text: `order ${o.id} (trade ${o.tradeId}) has a verdict against the provider and ${Math.floor(minutesLeft)} minute(s) left to recover ${o.usdcAmount - recovered} base units from its bond — nothing recovers this automatically`,
      });
    }
    return out;
  }

  async metrics() {
    const nowSec = nowSeconds();
    const [grouped, openDisputes, stuckFiatPaid, overdueFunded, indexer] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.count({ where: openDisputesWhere() }),
      this.prisma.order.count({ where: releaseOverdueWhere(nowSec) }),
      this.prisma.order.count({ where: fiatPaymentOverdueWhere(nowSec) }),
      this.prisma.indexerState.findUnique({ where: { id: 1 } }),
    ]);

    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count._all;
    const indexerLagSeconds = indexer?.updatedAt
      ? Math.round((Date.now() - indexer.updatedAt.getTime()) / 1000)
      : null;

    return {
      generated_at: new Date().toISOString(),
      orders_by_status: byStatus,
      open_disputes: openDisputes,
      release_overdue: stuckFiatPaid,
      fiat_payment_overdue: overdueFunded,
      indexer_lag_seconds: indexerLagSeconds,
    };
  }

  private running = false;

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAndAlert() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runCheck();
    } finally {
      this.running = false;
    }
  }

  private async runCheck() {
    let m: Awaited<ReturnType<MonitoringService['metrics']>>;
    try {
      m = await this.metrics();
    } catch (e) {
      this.log.error(`metrics query failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const incomplete = new Set<string>();
    let alerts: Alert[];
    try {
      alerts = await this.buildAlerts(m, incomplete);
    } catch (e) {
      this.log.error(
        `alert conditions could not be read: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (alerts.length === 0) {
      this.log.log(
        `ok — disputes:${m.open_disputes} release_overdue:${m.release_overdue} indexer_lag:${m.indexer_lag_seconds}s`,
      );
    } else {
      this.log.warn(`⚠️ lolipay coordinator: ${alerts.map((a) => a.text).join(' · ')}`);
    }

    await this.alerts.raise(MONITORING_ALERT_SCOPE, alerts, incomplete);
  }

  async buildAlerts(
    m: Awaited<ReturnType<MonitoringService['metrics']>>,
    incomplete: Set<string> = new Set(),
  ): Promise<Alert[]> {
    const nowSec = nowSeconds();
    const [disputes, releaseOverdue, fiatOverdue] = await Promise.all([
      this.sample(openDisputesWhere()),
      this.sample(releaseOverdueWhere(nowSec)),
      this.sample(fiatPaymentOverdueWhere(nowSec)),
    ]);

    const overflow: Alert[] = [];
    const noteOverflow = (kind: string, sampled: unknown[], label: string) => {
      if (sampled.length < ALERT_SAMPLE_LIMIT) return;
      incomplete.add(kind);
      overflow.push({
        key: `${kind}:overflow`,
        fingerprint: 'at-limit',
        urgency: 'routine',
        text: `at least ${ALERT_SAMPLE_LIMIT} ${label} — the list is truncated and nothing in this family will be reported as cleared until it is not`,
      });
    };
    noteOverflow('open_dispute', disputes, 'open disputes');
    noteOverflow('release_overdue', releaseOverdue, 'orders past their confirm deadline');
    noteOverflow('fiat_payment_overdue', fiatOverdue, 'funded orders with unpaid fiat');

    const alerts: Alert[] = [
      ...overflow,
      ...disputes.map((o) => {
        const since = o.disputeAt ?? o.createdAt;
        const days = Math.floor((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
        const stale = days >= DISPUTE_STALE_DAYS;
        return {
          key: `open_dispute:${o.id}`,
          fingerprint: stale ? 'stale' : 'open',
          urgency: (stale ? 'urgent' : 'routine') as Urgency,
          text: stale
            ? `order ${o.id} (trade ${o.tradeId}) has been disputed for ${days} days and nobody has resolved it — the escrow entry expires 45 days after its last write, after which the funds need a ledger restore`
            : `order ${o.id} (trade ${o.tradeId}) is disputed and awaiting resolution`,
        };
      }),
      ...releaseOverdue.map((o) => ({
        key: `release_overdue:${o.id}`,
        fingerprint: o.id,
        urgency: 'routine' as Urgency,
        text: `order ${o.id} (trade ${o.tradeId}) is past its confirm deadline, release overdue`,
      })),
      ...fiatOverdue.map((o) => ({
        key: `fiat_payment_overdue:${o.id}`,
        fingerprint: o.id,
        urgency: 'routine' as Urgency,
        text: `order ${o.id} (trade ${o.tradeId}) is funded but the fiat is unpaid past its deadline`,
      })),
    ];

    try {
      alerts.push(...(await this.slashWindowAlerts(new Date(), incomplete)));
    } catch (e) {
      this.log.error(
        `could not check for open slash windows: ${e instanceof Error ? e.message : String(e)}`,
      );
      incomplete.add('slash_window_open');
    }

    const stuck = await this.outbox.stuckCounts();
    if (stuck.failed > 0 || stuck.stalled > 0) {
      alerts.push({
        key: 'delivery_failing',
        fingerprint: `${stuck.failed}/${stuck.stalled}`,
        urgency: 'routine',
        text: `${stuck.failed} message(s) gave up and ${stuck.stalled} have been waiting too long — something this service tried to tell you did not arrive`,
      });
    }

    if (m.indexer_lag_seconds == null) {
      alerts.push({
        key: 'indexer_stalled',
        fingerprint: 'never',
        urgency: 'routine',
        text: 'indexer has never run',
      });
    } else if (m.indexer_lag_seconds > INDEXER_LAG_ALERT_SECONDS) {
      alerts.push({
        key: 'indexer_stalled',
        fingerprint: 'lagging',
        urgency: 'routine',
        text: `indexer lag ${m.indexer_lag_seconds}s (stalled?)`,
      });
    }
    return alerts;
  }

  private async sample(
    where: Prisma.OrderWhereInput,
  ): Promise<{ id: string; tradeId: string; disputeAt: Date | null; createdAt: Date }[]> {
    return this.prisma.order.findMany({
      where,
      select: { id: true, tradeId: true, disputeAt: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ALERT_SAMPLE_LIMIT,
    });
  }

}

function bucketOf(minutesLeft: number): string {
  if (minutesLeft <= 15) return 'under-15m';
  if (minutesLeft <= 60) return 'under-1h';
  if (minutesLeft <= 6 * 60) return 'under-6h';
  return 'over-6h';
}
