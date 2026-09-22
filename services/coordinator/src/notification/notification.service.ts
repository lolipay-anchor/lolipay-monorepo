import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { OutboxService } from '../outbox/outbox.service';
import { PersonService } from '../person/person.service';
import { EMAIL_OUTBOX_KIND } from '../email/email.service';
import { signingCutoffSecs } from '../config/contract-limits';

const NOTIFICATIONS_PAGE_SIZE = 50;
const NOTIFICATIONS_ORDER: Prisma.NotificationOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

type Role = 'user' | 'lp';
interface Msg {
  title: string;
  body: string;
}

function messageFor(
  flow: string,
  status: string,
  role: Role,
  settledAt?: Date | null,
  payDeadline?: bigint | number | null,
  lpPenalized = false,
): Msg | null {
  const isBuy = flow === 'TOP_UP';
  switch (status) {
    case 'MATCHED': {
      if (role !== 'lp') return null;
      if (!isBuy) {
        return {
          title: 'New order assigned',
          body: 'An order has been assigned to you. The seller locks their USDC first — nothing is needed from you yet.',
        };
      }
      const buildsUntil =
        payDeadline == null ? null : new Date(signingCutoffSecs(Number(payDeadline)) * 1000);
      return {
        title: 'New order — lock the USDC',
        body: buildsUntil
          ? `An order has been assigned to you. Lock the USDC in escrow before ${buildsUntil.toISOString()} or the assignment expires.`
          : 'An order has been assigned to you. Lock the USDC in escrow before the assignment expires.',
      };
    }
    case 'MATCHED_EXPIRED':
      if (role === 'user')
        return { title: 'Order expired', body: 'Your order was not completed on-chain in time and was cancelled.' };
      return lpPenalized
        ? {
            title: 'Assignment expired — you have been set unavailable',
            body: 'The order assigned to you was not completed on-chain in time, so this anchor has set you unavailable. It is closed and will not come back to you. You will not be assigned new orders until you set yourself available again on your dashboard.',
          }
        : {
            title: 'Assignment expired',
            body: 'The order assigned to you was not completed on-chain in time. It is closed and will not come back to you.',
          };
    case 'CANCELLED':
      return role === 'user'
        ? { title: 'Order cancelled', body: 'Your order was cancelled before it was funded on-chain.' }
        : { title: 'Assignment cancelled', body: 'The order assigned to you was cancelled before anything was locked on chain. Nothing is needed from you.' };
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
      if (isBuy)
        return role === 'user'
          ? { title: 'Order refunded', body: 'The USDC was returned to the merchant and this order is closed.' }
          : { title: 'Order refunded', body: 'The USDC you locked was returned to your wallet and this order is closed.' };
      return role === 'user'
        ? { title: 'Order refunded', body: 'Your USDC was returned to your wallet and this order is closed.' }
        : { title: 'Order refunded', body: 'The USDC was returned to the seller and this order is closed. It did not come to you.' };
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
    private outbox: OutboxService,
    private people: PersonService,
    private realtime?: RealtimeGateway,
  ) {}

  async notifyOrderStatus(

    order: {
      id: string;
      userAddress: string;
      lpWallet: string | null;
      flow: string;
      settledAt?: Date | null;
      payDeadline?: bigint | number | null;
    },
    status: string,
    lpPenalized = false,
  ): Promise<void> {
    const rows: any[] = [];
    const u = messageFor(order.flow, status, 'user', order.settledAt, order.payDeadline, lpPenalized);
    if (u) rows.push({ address: order.userAddress, orderId: order.id, event: status, ...u });
    const l = messageFor(order.flow, status, 'lp', order.settledAt, order.payDeadline, lpPenalized);
    if (l && order.lpWallet && order.lpWallet !== order.userAddress) {
      rows.push({ address: order.lpWallet, orderId: order.id, event: status, ...l });
    }
    if (rows.length > 0) {
      const recipients = await Promise.all(
        rows.map(async (r) => ({ row: r, person: await this.people.lookupPerson(r.address) })),
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.notification.createMany({ data: rows, skipDuplicates: true });
        for (const { row, person } of recipients) {
          if (!person?.email) continue;
          await this.outbox.enqueue(tx, {
            kind: EMAIL_OUTBOX_KIND,
            dedupeKey: `${EMAIL_OUTBOX_KIND}:${order.id}:${status}:${person.id}`,
            payload: { personId: person.id, subject: row.title, text: row.body },
          });
        }
      });
    }

    this.realtime?.emitOrderUpdate({
      id: order.id,
      status,
      flow: order.flow,
      userAddress: order.userAddress,
      lpWallet: order.lpWallet,
    });
  }

  list(address: string, take = NOTIFICATIONS_PAGE_SIZE) {
    return this.prisma.notification.findMany({
      where: { address },
      orderBy: NOTIFICATIONS_ORDER,
      take,
    });
  }

  unreadCount(address: string) {
    return this.prisma.notification.count({ where: { address, read: false } });
  }

  async markAllRead(address: string, take = NOTIFICATIONS_PAGE_SIZE) {
    const shown = await this.prisma.notification.findMany({
      where: { address },
      orderBy: NOTIFICATIONS_ORDER,
      take,
      select: { id: true },
    });
    if (shown.length === 0) return;
    await this.prisma.notification.updateMany({
      where: { id: { in: shown.map((r) => r.id) }, read: false },
      data: { read: true },
    });
  }
}
