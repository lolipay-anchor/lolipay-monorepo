import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';

const INDEXER_LAG_ALERT_SECONDS = 120;

@Injectable()
export class MonitoringService {
  private readonly log = new Logger('Monitoring');
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
  ) {}

  async metrics() {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const [grouped, openDisputes, stuckFiatPaid, overdueFunded, indexer] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.count({ where: { status: 'DISPUTED' } }),

      this.prisma.order.count({
        where: { status: 'FIAT_PAID', confirmDeadline: { lt: nowSec } },
      }),

      this.prisma.order.count({ where: { status: 'FUNDED', payDeadline: { lt: nowSec } } }),
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

    const alerts: string[] = [];
    if (m.open_disputes > 0) {
      alerts.push(`${m.open_disputes} open dispute(s) awaiting resolution`);
    }
    if (m.release_overdue > 0) {
      alerts.push(`${m.release_overdue} order(s) past confirm deadline (release overdue)`);
    }
    if (m.fiat_payment_overdue > 0) {
      alerts.push(`${m.fiat_payment_overdue} FUNDED order(s) past pay deadline (fiat unpaid)`);
    }
    if (m.indexer_lag_seconds == null) {
      alerts.push('indexer has never run');
    } else if (m.indexer_lag_seconds > INDEXER_LAG_ALERT_SECONDS) {
      alerts.push(`indexer lag ${m.indexer_lag_seconds}s (stalled?)`);
    }

    if (alerts.length === 0) {
      this.log.log(
        `ok — disputes:${m.open_disputes} release_overdue:${m.release_overdue} indexer_lag:${m.indexer_lag_seconds}s`,
      );
      return;
    }
    const text = `⚠️ lolipay coordinator: ${alerts.join(' · ')}`;
    this.log.warn(text);
    await this.sendWebhook(text, m);
  }

  private async sendWebhook(text: string, metrics: unknown) {
    const url = this.cfg.alertWebhookUrl;
    if (!url) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, metrics }),
      });
    } catch (e) {
      this.log.error(`alert webhook failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
