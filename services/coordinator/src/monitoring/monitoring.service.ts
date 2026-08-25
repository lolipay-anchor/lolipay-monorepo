import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { Prisma } from '../generated/prisma/client';
import {
  ALERT_SAMPLE_LIMIT,
  ALERT_TEXT_LIMIT,
  fiatPaymentOverdueWhere,
  nowSeconds,
  openDisputesWhere,
  releaseOverdueWhere,
} from './monitoring.conditions';

const INDEXER_LAG_ALERT_SECONDS = 120;
const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const URGENT_REMINDER_INTERVAL_MS = 15 * 60 * 1000;
const WEBHOOK_TIMEOUT_MS = 5000;

export type Urgency = 'routine' | 'urgent';

export function summarise(alerts: Alert[], limit: number = ALERT_TEXT_LIMIT): string {
  const shown = alerts.slice(0, limit).map((a) => a.text).join(' · ');
  if (alerts.length <= limit) return shown;
  return `${shown} · and ${alerts.length - limit} more not listed`;
}

export interface Alert {
  key: string;
  fingerprint: string;
  urgency: Urgency;
  text: string;
}

@Injectable()
export class MonitoringService implements OnModuleInit {
  private readonly log = new Logger('Monitoring');
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
  ) {}

  onModuleInit() {
    if (!this.cfg.alertWebhookUrl) {
      this.log.error(
        'ALERT_WEBHOOK_URL is unset: every alert this service raises will be written to the log and delivered nowhere',
      );
    }
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
    const { toSend, resolved } = await this.reconcileAlerts(alerts);

    if (alerts.length === 0) {
      this.log.log(
        `ok — disputes:${m.open_disputes} release_overdue:${m.release_overdue} indexer_lag:${m.indexer_lag_seconds}s`,
      );
    } else {
      this.log.warn(`⚠️ lolipay coordinator: ${alerts.map((a) => a.text).join(' · ')}`);
    }

    const now = new Date();
    if (toSend.length > 0) {
      const urgent = toSend.some((a) => a.urgency === 'urgent');
      const prefix = urgent ? '🚨 lolipay coordinator' : '⚠️ lolipay coordinator';
      const delivered = await this.sendWebhook(`${prefix}: ${summarise(toSend)}`, m);
      if (delivered) await this.recordSent(toSend, now);
    }
    if (resolved.length > 0) {
      const shown = resolved.slice(0, ALERT_TEXT_LIMIT).join(' · ');
      const rest =
        resolved.length > ALERT_TEXT_LIMIT ? ` and ${resolved.length - ALERT_TEXT_LIMIT} more` : '';
      const delivered = await this.sendWebhook(
        `✅ lolipay coordinator: ${shown}${rest} — cleared`,
        m,
      );
      if (delivered) await this.forgetResolved(resolved);
    }
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
      ...disputes.map((o) => ({
        key: `open_dispute:${o.id}`,
        fingerprint: o.id,
        urgency: 'routine' as Urgency,
        text: `order ${o.id} (trade ${o.tradeId}) is disputed and awaiting resolution`,
      })),
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
  ): Promise<{ id: string; tradeId: string }[]> {
    return this.prisma.order.findMany({
      where,
      select: { id: true, tradeId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ALERT_SAMPLE_LIMIT,
    });
  }

  async reconcileAlerts(
    alerts: Alert[],
    now: Date = new Date(),
  ): Promise<{ toSend: Alert[]; resolved: string[] }> {
    let known: { key: string; fingerprint: string; lastSentAt: Date }[];
    try {
      known = await this.prisma.alertState.findMany({
        select: { key: true, fingerprint: true, lastSentAt: true },
      });
    } catch (e) {
      this.log.error(
        `alert state unreadable, sending every alert rather than staying silent: ${e instanceof Error ? e.message : String(e)}`,
      );
      return { toSend: alerts, resolved: [] };
    }
    const byKey = new Map(known.map((k) => [k.key, k]));
    const live = new Set(alerts.map((a) => a.key));

    const toSend: Alert[] = [];
    for (const a of alerts) {
      const seen = byKey.get(a.key);
      const isNew = !seen;
      const changed = seen != null && seen.fingerprint !== a.fingerprint;
      const stale =
        seen != null && now.getTime() - seen.lastSentAt.getTime() >= REMINDER_INTERVAL_MS;
      const urgentDue =
        a.urgency === 'urgent' &&
        (seen == null ||
          now.getTime() - seen.lastSentAt.getTime() >= URGENT_REMINDER_INTERVAL_MS);
      if (urgentDue || isNew || changed || stale) {
        toSend.push(a);
      }
    }

    const resolved = known
      .filter((k) => !live.has(k.key))
      .map((k) => k.key)
      .filter((key) => {
        const family = key.split(':')[0];
        return !this.truncated.has(family);
      });
    return { toSend, resolved };
  }

  private async recordSent(alerts: Alert[], now: Date): Promise<void> {
    if (alerts.length === 0) return;
    try {
      await this.prisma.$transaction(
        alerts.map((a) =>
          this.prisma.alertState.upsert({
            where: { key: a.key },
            create: { key: a.key, fingerprint: a.fingerprint, lastSentAt: now },
            update: { fingerprint: a.fingerprint, lastSentAt: now, sendCount: { increment: 1 } },
          }),
        ),
      );
    } catch (e) {
      this.log.error(
        `could not record alert state, the next tick will send these again: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async forgetResolved(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await this.prisma.alertState.deleteMany({ where: { key: { in: keys } } });
    } catch (e) {
      this.log.error(
        `could not clear alert state: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async sendWebhook(text: string, metrics: unknown): Promise<boolean> {
    const url = this.cfg.alertWebhookUrl;
    if (!url) return false;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, metrics }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.error(`alert webhook rejected the alert with ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      this.log.error(`alert webhook failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
