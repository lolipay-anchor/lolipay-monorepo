import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { RefundSignerService } from '../stellar/refund-signer.service';
import { AppConfigService } from '../config/app-config.service';
import { NotificationService } from '../notification/notification.service';
import { contractIdFor } from '../order/order.params';

const AUTO_REFUND_BATCH_SIZE = 20;

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
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async expireStaleOrders() {
    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'] },
        expiresAt: { lt: new Date() },
      },
      select: {
        id: true,
        tradeId: true,
        contractId: true,
        status: true,
        userAddress: true,
        lpWallet: true,
        flow: true,
      },
      take: 200,
    });

    let expired = 0;
    for (const o of candidates) {
      try {
        const onChain = await this.stellar.getTradeStatusStrict(contractIdFor(o, this.cfg), o.tradeId);
        if (onChain) continue;
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
  async pruneOldQuotes() {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const res = await this.prisma.quote.deleteMany({
      where: { expiresAt: { lt: cutoff } },
    });
    if (res.count > 0) this.log.log(`pruned ${res.count} expired quote(s)`);
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async autoRefundExpired() {
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
      where: { status: 'FUNDED', payDeadline: { lt: nowSecs } },
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

        const advanced = await this.prisma.order.updateMany({
          where: { id: o.id, status: 'FUNDED' },
          data: { status: 'REFUNDED' },
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
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
