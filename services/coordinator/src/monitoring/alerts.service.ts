import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { ALERT_TEXT_BUDGET } from './monitoring.conditions';

export const ALERT_OUTBOX_KIND = 'ops_alert';
export const REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const URGENT_REMINDER_INTERVAL_MS = 15 * 60 * 1000;
export const WEBHOOK_TIMEOUT_MS = 5000;

export type Urgency = 'routine' | 'urgent';

export interface Alert {
  key: string;
  fingerprint: string;
  urgency: Urgency;
  text: string;
}

export function familyOf(key: string): string {
  return key.split(':')[0];
}

export function byUrgencyFirst(alerts: Alert[]): Alert[] {
  return [...alerts].sort((a, b) => {
    if (a.urgency === b.urgency) return 0;
    return a.urgency === 'urgent' ? -1 : 1;
  });
}

export function fitToBudget(
  alerts: Alert[],
  budget: number = ALERT_TEXT_BUDGET,
): { included: Alert[]; omitted: number } {
  const ordered = byUrgencyFirst(alerts);
  const included: Alert[] = [];
  let used = 0;
  for (const a of ordered) {
    const cost = a.text.length + 3;
    if (used + cost > budget) break;
    included.push(a);
    used += cost;
  }
  if (included.length === 0 && ordered.length > 0) included.push(ordered[0]);
  return { included, omitted: alerts.length - included.length };
}

export function summarise(alerts: Alert[], budget: number = ALERT_TEXT_BUDGET): string {
  const shown: string[] = [];
  let used = 0;
  for (const a of byUrgencyFirst(alerts)) {
    const cost = a.text.length + 3;
    if (used + cost > budget) break;
    shown.push(a.text);
    used += cost;
  }
  if (shown.length === 0 && alerts.length > 0) {
    shown.push(alerts[0].text.slice(0, budget));
  }
  const omitted = alerts.length - shown.length;
  const body = shown.join(' · ');
  return omitted > 0 ? `${body} · and ${omitted} more not listed` : body;
}

@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly log = new Logger('Alerts');

  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private outbox: OutboxService,
  ) {}

  onModuleInit() {
    this.outbox.register(ALERT_OUTBOX_KIND, (payload) => this.deliver(payload));
    if (!this.cfg.alertWebhookUrl) {
      this.log.error(
        'ALERT_WEBHOOK_URL is unset: every alert this service raises will be written to the log and delivered nowhere',
      );
    }
  }

  async raise(
    scope: string[],
    alerts: Alert[],
    incomplete: Set<string> = new Set(),
    now: Date = new Date(),
  ): Promise<{ sent: Alert[]; cleared: string[] }> {
    const inScope = new Set(scope);
    const mine = alerts.filter((a) => inScope.has(familyOf(a.key)));

    let known: {
      key: string;
      fingerprint: string;
      lastSentAt: Date;
      firstSeenAt: Date;
      sendCount: number;
    }[];
    try {
      known = await this.prisma.alertState.findMany();
    } catch (e) {
      this.log.error(
        `alert state unreadable, sending every alert rather than staying silent: ${errMsg(e)}`,
      );
      try {
        await this.publish(mine, [], now, undefined, blindDedupeKey(mine, now));
      } catch (publishError) {
        this.log.error(`could not queue the blind alert: ${errMsg(publishError)}`);
      }
      return { sent: mine, cleared: [] };
    }

    const ownedKnown = known.filter((k) => inScope.has(familyOf(k.key)));
    const byKey = new Map(ownedKnown.map((k) => [k.key, k]));
    const live = new Set(mine.map((a) => a.key));

    const sent: Alert[] = [];
    for (const a of mine) {
      const seen = byKey.get(a.key);
      const elapsed = seen ? now.getTime() - seen.lastSentAt.getTime() : Infinity;
      const due =
        a.urgency === 'urgent'
          ? elapsed >= URGENT_REMINDER_INTERVAL_MS
          : elapsed >= REMINDER_INTERVAL_MS;
      if (!seen || seen.fingerprint !== a.fingerprint || due) sent.push(a);
    }

    const cleared = ownedKnown
      .filter((k) => !live.has(k.key))
      .map((k) => k.key)
      .filter((key) => !incomplete.has(familyOf(key)));

    const { included, omitted } = fitToBudget(sent);
    if (omitted > 0) {
      this.log.warn(
        `${omitted} alert(s) did not fit this message and are deliberately not recorded as sent, so the next tick raises them again`,
      );
    }
    await this.commit(included, cleared, byKey, now);
    return { sent: included, cleared };
  }

  private async commit(
    sent: Alert[],
    cleared: string[],
    byKey: Map<string, { firstSeenAt: Date; sendCount: number }>,
    now: Date,
  ): Promise<void> {
    if (sent.length === 0 && cleared.length === 0) return;
    if (!this.cfg.alertWebhookUrl) return;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (sent.length > 0) {
          await tx.alertState.deleteMany({ where: { key: { in: sent.map((a) => a.key) } } });
          await tx.alertState.createMany({
            data: sent.map((a) => {
              const prior = byKey.get(a.key);
              return {
                key: a.key,
                fingerprint: a.fingerprint,
                lastSentAt: now,
                firstSeenAt: prior?.firstSeenAt ?? now,
                sendCount: (prior?.sendCount ?? 0) + 1,
              };
            }),
          });
        }
        if (cleared.length > 0) {
          await tx.alertState.deleteMany({ where: { key: { in: cleared } } });
        }
        await this.publish(sent, cleared, now, tx);
      });
    } catch (e) {
      this.log.error(`could not record alerts, the next tick will raise them again: ${errMsg(e)}`);
    }
  }

  private async publish(
    sent: Alert[],
    cleared: string[],
    now: Date,
    tx?: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    dedupeKey?: string,
  ): Promise<void> {
    if (!this.cfg.alertWebhookUrl) return;
    const client = tx ?? this.prisma;
    if (sent.length > 0) {
      const urgent = sent.some((a) => a.urgency === 'urgent');
      const prefix = urgent ? '🚨 lolipay coordinator' : '⚠️ lolipay coordinator';
      await this.outbox.enqueue(client, {
        kind: ALERT_OUTBOX_KIND,
        payload: { text: `${prefix}: ${summarise(sent)}`, at: now.toISOString() },
        dedupeKey,
      });
    }
    if (cleared.length > 0) {
      const body = summarise(
        cleared.map((key) => ({ key, fingerprint: key, urgency: 'routine' as Urgency, text: key })),
      );
      await this.outbox.enqueue(client, {
        kind: ALERT_OUTBOX_KIND,
        payload: { text: `✅ lolipay coordinator: ${body} — cleared`, at: now.toISOString() },
        dedupeKey: dedupeKey ? `${dedupeKey}:cleared` : undefined,
      });
    }
  }

  async deliver(payload: Record<string, unknown>): Promise<void> {
    const url = this.cfg.alertWebhookUrl;
    if (!url) throw new Error('ALERT_WEBHOOK_URL is unset');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: payload.text, content: payload.text }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      throw new Error(
        `alert webhook request failed: ${e instanceof Error ? e.name : 'unknown error'}`,
      );
    }
    if (!res.ok) {
      throw new Error(`alert webhook responded ${res.status}`);
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function blindDedupeKey(alerts: Alert[], now: Date): string {
  const shape = alerts
    .map((a) => `${a.key}=${a.fingerprint}`)
    .sort()
    .join('|');
  const bucket = Math.floor(now.getTime() / REMINDER_INTERVAL_MS);
  return `${ALERT_OUTBOX_KIND}:blind:${bucket}:${createHash('sha256').update(shape).digest('hex').slice(0, 32)}`;
}
