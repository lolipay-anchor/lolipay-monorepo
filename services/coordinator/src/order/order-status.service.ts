import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TradeOnChain } from '../stellar/stellar-read.types';
import { verifyTradeMatchesOrder } from './trade-binding';
import { contractIdFor } from './order.params';

export const REFRESH_FROM_CHAIN_STATUSES = [
  'MATCHED',
  'AWAITING_ONCHAIN',
  'FUNDED',
  'FIAT_PAID',
  'DISPUTED',
];

export const STATUS_ORDER = [
  'CREATED',
  'MATCHED',
  'AWAITING_ONCHAIN',
  'FUNDED',
  'FIAT_PAID',
  'DISPUTED',
  'RELEASED',
  'REFUNDED',
  'EXPIRED',
  'CANCELLED',
];

const NOT_YET_BOUND_ON_CHAIN = ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'EXPIRED'];

export function isAhead(newStatus: string, currentStatus: string): boolean {
  const newIdx = STATUS_ORDER.indexOf(newStatus);
  const curIdx = STATUS_ORDER.indexOf(currentStatus);
  return newIdx > curIdx;
}

@Injectable()
export class OrderStatusService {
  private readonly log = new Logger('OrderStatusService');

  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private cfg: AppConfigService,
    private realtime?: RealtimeGateway,
  ) {}

  contractIdFor(order: { contractId?: string | null }): string {
    return contractIdFor(order, this.cfg);
  }

  tradeBindsToOrder(onChain: TradeOnChain, order: any): boolean {
    if (!NOT_YET_BOUND_ON_CHAIN.includes(order.status)) return true;

    const mismatches = verifyTradeMatchesOrder(onChain, order);
    if (mismatches.length === 0) return true;

    this.log.error(
      `order ${order.id} (tradeId ${order.tradeId}): REFUSING to bind — the on-chain trade does not match the order. ${mismatches.join(' | ')}`,
    );
    return false;
  }

  async refreshOrderStatus(id: string, order: any): Promise<any> {
    if (!REFRESH_FROM_CHAIN_STATUSES.includes(order.status)) {
      return order;
    }
    const onChain = await this.stellar.getTradeStatus(this.contractIdFor(order), order.tradeId);

    if (onChain && !this.tradeBindsToOrder(onChain, order)) return order;

    if (onChain && isAhead(onChain.status, order.status)) {
      const updated = await this.prisma.order.update({
        where: { id },
        data: { status: onChain.status as any },
        include: { lp: true },
      });

      this.realtime?.emitOrderUpdate({
        id: updated.id,
        status: updated.status,
        flow: updated.flow,
        userAddress: updated.userAddress,
        lpWallet: updated.lpWallet,
      });
      return updated;
    }
    return order;
  }
}
