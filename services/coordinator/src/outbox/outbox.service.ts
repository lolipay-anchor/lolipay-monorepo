import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BATCH_SIZE = 50;
export const OUTBOX_BACKOFF_BASE_MS = 30_000;
export const OUTBOX_BACKOFF_CAP_MS = 30 * 60 * 1000;
export const OUTBOX_KEEP_SENT_MS = 14 * 24 * 60 * 60 * 1000;

export function backoffFor(attempts: number, base = OUTBOX_BACKOFF_BASE_MS): number {
  const grown = base * 2 ** Math.max(0, attempts - 1);
  return Math.min(grown, OUTBOX_BACKOFF_CAP_MS);
}

export interface OutboxJob {
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

export type OutboxTxClient = Pick<Prisma.TransactionClient, 'outboxMessage'>;

export type OutboxHandler = (payload: Record<string, unknown>) => Promise<void>;

@Injectable()
export class OutboxService {
  private readonly log = new Logger('Outbox');
  private readonly handlers = new Map<string, OutboxHandler>();
  private draining = false;

  constructor(private prisma: PrismaService) {}

  register(kind: string, handler: OutboxHandler): void {
    this.handlers.set(kind, handler);
  }

  async enqueue(tx: OutboxTxClient, job: OutboxJob): Promise<void> {
    await tx.outboxMessage.createMany({
      data: [
        {
          kind: job.kind,
          payload: job.payload as Prisma.InputJsonValue,
          dedupeKey: job.dedupeKey ?? null,
        },
      ],
      skipDuplicates: true,
    });
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainOnce();
    } catch (err) {
      this.log.warn(`drain failed: ${errMsg(err)}`);
    } finally {
      this.draining = false;
    }
  }

  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - OUTBOX_KEEP_SENT_MS);
    const { count } = await this.prisma.outboxMessage.deleteMany({
      where: { status: 'SENT', sentAt: { lt: cutoff } },
    });
    if (count > 0) this.log.log(`pruned ${count} delivered message(s) older than 14 days`);
    return count;
  }

  async stuckCounts(now: Date = new Date()): Promise<{ failed: number; stalled: number }> {
    const [failed, stalled] = await Promise.all([
      this.prisma.outboxMessage.count({ where: { status: 'FAILED' } }),
      this.prisma.outboxMessage.count({
        where: {
          status: 'PENDING',
          createdAt: { lt: new Date(now.getTime() - OUTBOX_BACKOFF_CAP_MS * 2) },
        },
      }),
    ]);
    return { failed, stalled };
  }

  async drainOnce(): Promise<number> {
    const now = new Date();
    const pending = await this.prisma.outboxMessage.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: OUTBOX_BATCH_SIZE,
    });

    let sent = 0;
    for (const msg of pending) {
      const handler = this.handlers.get(msg.kind);
      if (!handler) {
        const attempts = msg.attempts + 1;
        const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.prisma.outboxMessage.updateMany({
          where: { id: msg.id, status: 'PENDING' },
          data: {
            attempts,
            lastError: `no handler registered for kind "${msg.kind}"`,
            status: exhausted ? 'FAILED' : 'PENDING',
            nextAttemptAt: new Date(Date.now() + backoffFor(attempts)),
          },
        });
        this.log.warn(
          `no handler registered for outbox kind "${msg.kind}" (message ${msg.id}), attempt ${attempts}${exhausted ? ' — giving up so it cannot hold the queue' : ''}`,
        );
        continue;
      }

      try {
        await handler(msg.payload as Record<string, unknown>);
        await this.prisma.outboxMessage.updateMany({
          where: { id: msg.id, status: 'PENDING' },
          data: { status: 'SENT', sentAt: new Date() },
        });
        sent += 1;
      } catch (err) {
        const attempts = msg.attempts + 1;
        const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;
        await this.prisma.outboxMessage.updateMany({
          where: { id: msg.id, status: 'PENDING' },
          data: {
            attempts,
            lastError: errMsg(err).slice(0, 500),
            status: exhausted ? 'FAILED' : 'PENDING',
            nextAttemptAt: new Date(Date.now() + backoffFor(attempts)),
          },
        });
        if (exhausted) {
          this.log.error(
            `outbox message ${msg.id} (${msg.kind}) failed ${attempts} times and will not be retried: ${errMsg(err)}`,
          );
        } else {
          this.log.warn(`outbox message ${msg.id} (${msg.kind}) attempt ${attempts} failed: ${errMsg(err)}`);
        }
      }
    }
    return sent;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
