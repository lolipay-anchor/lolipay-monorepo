import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { Alert, AlertsService, Urgency } from './alerts.service';
import {
  ALERT_SAMPLE_LIMIT,
  DISPUTE_STALE_DAYS,
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
];

@Injectable()
export class MonitoringService {
  private readonly log = new Logger('Monitoring');
  constructor(
    private prisma: PrismaService,
    private alerts: AlertsService,
  ) {}

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

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAndAlert() {
    let m: Awaited<ReturnType<MonitoringService['metrics']>>;
    try {
      m = await this.metrics();
    } catch (e) {
      this.log.error(`metrics query failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    let alerts: Alert[];
    try {
      alerts = await this.buildAlerts(m);
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

    await this.alerts.raise(MONITORING_ALERT_SCOPE, alerts, this.truncated);
  }

  private truncated = new Set<string>();

  async buildAlerts(m: Awaited<ReturnType<MonitoringService['metrics']>>): Promise<Alert[]> {
    const nowSec = nowSeconds();
    const [disputes, releaseOverdue, fiatOverdue] = await Promise.all([
      this.sample(openDisputesWhere()),
      this.sample(releaseOverdueWhere(nowSec)),
      this.sample(fiatPaymentOverdueWhere(nowSec)),
    ]);

    const overflow: Alert[] = [];
    this.truncated = new Set<string>();
    const noteOverflow = (kind: string, sampled: unknown[], label: string) => {
      if (sampled.length < ALERT_SAMPLE_LIMIT) return;
      this.truncated.add(kind);
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
