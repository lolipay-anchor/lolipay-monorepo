import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BATCH_SIZE = 50;

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

  async drainOnce(): Promise<number> {
    const pending = await this.prisma.outboxMessage.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
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
