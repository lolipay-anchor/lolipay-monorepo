import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrismaService } from '../prisma/prisma.service';

export const EMAIL_OUTBOX_KIND = 'email';

const ENDPOINT = 'https://api.resend.com/emails';

type Sent = { ok: boolean; status: number; body: string };

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly log = new Logger('Email');

  constructor(
    private cfg: AppConfigService,
    private outbox: OutboxService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.outbox.register(EMAIL_OUTBOX_KIND, (payload) => this.deliver(payload));
    if (!this.cfg.resendApiKey) {
      this.log.error(
        'RESEND_API_KEY is unset: every notification email this anchor queues will fail to send and stay queued until it is set',
      );
    }
  }

  async deliver(payload: Record<string, unknown>): Promise<void> {
    const personId = typeof payload.personId === 'string' ? payload.personId.trim() : '';
    if (!personId) {
      throw new Error('email job carries no personId, refusing to send');
    }

    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { email: true },
    });
    const to = person?.email?.trim() ?? '';
    if (!to) return;

    if (!this.cfg.resendApiKey) {
      throw new Error('email is not configured: RESEND_API_KEY is unset');
    }

    const res = await this.post({
      from: this.cfg.resendFrom,
      to: [to],
      subject: String(payload.subject ?? ''),
      text: String(payload.text ?? ''),
    });

    if (!res.ok) {
      throw new Error(`email provider refused with ${res.status}: ${res.body.slice(0, 200)}`);
    }
  }

  private async post(body: Record<string, unknown>): Promise<Sent> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  }
}
