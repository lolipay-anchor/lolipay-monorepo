import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

type Role = 'user' | 'lp';
interface Msg {
  title: string;
  body: string;
}

function messageFor(flow: string, status: string, role: Role, settledAt?: Date | null): Msg | null {
  const isBuy = flow === 'TOP_UP';
  switch (status) {
    case 'MATCHED_EXPIRED':
      return role === 'user'
        ? { title: 'Order expired', body: 'Your order was not completed on-chain in time and was cancelled.' }
        : { title: 'Assignment expired', body: 'The order assigned to you was not completed on-chain in time — you are free to accept other orders.' };
    case 'FUNDED':
      if (isBuy)
        return role === 'user'
          ? { title: 'USDC locked', body: 'The merchant locked the USDC — pay now to receive it.' }
          : { title: 'You locked USDC', body: 'USDC is locked in escrow for your order.' };
      return role === 'user'
        ? { title: 'USDC locked', body: 'Your USDC is locked — waiting for the merchant to pay.' }
        : { title: 'Seller locked USDC', body: 'Pay the seller, then mark it paid to receive the USDC.' };
    case 'FIAT_PAID':
      if (isBuy)
        return role === 'user'
          ? { title: 'Payment marked', body: 'Waiting for the merchant to release your USDC.' }
          : { title: 'Buyer paid', body: 'Confirm receipt and release the USDC.' };
      return role === 'user'
        ? { title: 'Merchant paid', body: 'Confirm you received it to release the USDC.' }
        : { title: 'You marked paid', body: 'Waiting for the seller to confirm & release.' };
    case 'RELEASED':
      if (isBuy)
        return role === 'user'
          ? { title: 'USDC released 🎉', body: 'Your USDC has been released. Trade complete.' }
          : { title: 'Trade complete', body: 'The USDC was released to the buyer.' };
      return role === 'user'
        ? { title: 'Trade complete', body: 'Your USDC was released to the merchant.' }
        : { title: 'USDC released 🎉', body: 'The USDC was released to you. Trade complete.' };
    case 'REFUNDED':
      return { title: 'Order refunded', body: 'The locked USDC was refunded to the provider.' };
    case 'DISPUTED':
      if (settledAt) {
        return {
          title: 'Post-settlement dispute opened',
          body: 'A dispute was raised after this order settled — it is under review by the platform.',
        };
      }
      return { title: 'Dispute opened', body: 'This order is under review by the platform.' };
    default:
      return null;
  }
}

@Injectable()
export class NotificationService {
  constructor(
    private prisma: PrismaService,
    private realtime?: RealtimeGateway,
  ) {}

  async notifyOrderStatus(

    order: {
      id: string;
      userAddress: string;
      lpWallet: string | null;
      flow: string;
      settledAt?: Date | null;
    },
    status: string,
  ): Promise<void> {
    const rows: any[] = [];
    const u = messageFor(order.flow, status, 'user', order.settledAt);
    if (u) rows.push({ address: order.userAddress, orderId: order.id, event: status, ...u });
    const l = messageFor(order.flow, status, 'lp', order.settledAt);
    if (l && order.lpWallet && order.lpWallet !== order.userAddress) {
      rows.push({ address: order.lpWallet, orderId: order.id, event: status, ...l });
    }
    if (rows.length > 0) {
      await this.prisma.notification.createMany({ data: rows, skipDuplicates: true });
    }

    this.realtime?.emitOrderUpdate({
      id: order.id,
      status,
      flow: order.flow,
      userAddress: order.userAddress,
      lpWallet: order.lpWallet,
    });
  }

  list(address: string, take = 50) {
    return this.prisma.notification.findMany({
      where: { address },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  unreadCount(address: string) {
    return this.prisma.notification.count({ where: { address, read: false } });
  }

  async markAllRead(address: string) {
    await this.prisma.notification.updateMany({
      where: { address, read: false },
      data: { read: true },
    });
  }
}
