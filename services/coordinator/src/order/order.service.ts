import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { signingDeadlineSecs } from '../config/contract-limits';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { MatchingService } from '../matching/matching.service';
import { AppConfigService } from '../config/app-config.service';
import { MarketsService } from '../market/markets.service';
import { NotificationService } from '../notification/notification.service';
import { mapRoles, newTradeId, Flow, getFiatPayer } from './order.params';
import { serializeOrderBase } from './order.serialize';
import { lpExposure, LP_CAPACITY_LOCK_NAMESPACE } from './lp-exposure';
import { settlementFieldsFrom } from './order-status.service';
import { ConfigCache } from '../config/config-cache';
import {
  OrderStatusService,
  isAhead,
  REFRESH_FROM_CHAIN_STATUSES,
} from './order-status.service';
import { OrderTxService } from './order-tx.service';
import { generateRef } from './ref.util';
import { canDispute, allowedDisputeReasons, isOwnEvidencePath } from './dispute.util';
import { ObjectStorageService } from '../storage/object-storage.service';
import { UserReputationService } from '../reputation/user-reputation.service';
import { PROVIDER_LOST_WHERE } from '../reputation/dispute-outcome';


export const MAX_REF_ATTEMPTS = 5;

const PRE_CHAIN_STATUSES = ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'];

const FUNDED_OR_LATER = ['FUNDED', 'FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED'];

export interface CreateTradeParams {
  trade_id: string;
  usdc_provider: string;
  usdc_recipient: string;
  confirmer: string;
  usdc_amount: string;
  pay_deadline: number;
  confirm_deadline: number;
  dispute_deadline: number;
  platform_wallet: string;
  platform_fee_bps: number;
  lp_fee_bps: number;
}

@Injectable()
export class OrderService {
  private readonly log = new Logger('OrderService');

  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private matching: MatchingService,
    private cfg: AppConfigService,
    private markets: MarketsService,
    private notifications: NotificationService,
    private storage: ObjectStorageService,
    private userReputation: UserReputationService,
    private status: OrderStatusService,
    private tx: OrderTxService,
  ) {}

  private repCache = new Map<string, { val: Record<string, any>; at: number }>();
  private static REP_TTL_MS = 60_000;

  async getLpReputation(
    lpId: string,
    lp: { online: boolean; approvedAt: Date | null; createdAt: Date; disputesLost?: number },
  ): Promise<Record<string, any>> {
    const now = Date.now();
    const cached = this.repCache.get(lpId);
    if (cached && now - cached.at < OrderService.REP_TTL_MS) {
      return { ...cached.val, online: lp.online };
    }

    const [completed, refunded] = await Promise.all([
      this.prisma.order.count({
        where: {
          lpId,
          status: 'RELEASED',
          NOT: { OR: PROVIDER_LOST_WHERE },
        },
      }),
      this.prisma.order.count({
        where: { lpId, status: 'REFUNDED', flow: 'WITHDRAW' },
      }),
    ]);
    const concluded = completed + refunded;
    const val = {
      completed_trades: completed,
      completion_rate: concluded > 0 ? completed / concluded : null,
      disputes_lost: lp.disputesLost ?? 0,
      member_since: (lp.approvedAt ?? lp.createdAt).toISOString(),
    };
    this.repCache.set(lpId, { val, at: now });
    return { ...val, online: lp.online };
  }

  private async identityVerified(
    personId: string,
    db: {
      kycVerification: {
        findFirst: (a: any) => Promise<any>;
      };
    },
  ): Promise<boolean> {
    if (!personId) return false;
    const verification = await db.kycVerification.findFirst({
      where: { personId, status: 'ACCEPTED', screenedAt: { not: null } },
    });
    if (!verification) return false;
    const refused = await db.kycVerification.findFirst({
      where: { personId, status: 'REJECTED' },
    });
    return !refused;
  }

  private async assertIdentityVerified(
    personId: string,
    db: {
      kycVerification: {
        findFirst: (a: any) => Promise<any>;
      };
    },
  ): Promise<void> {
    if (!(await this.identityVerified(personId, db))) {
      throw new ForbiddenException(
        'identity verification is required before a trade can be opened',
      );
    }
  }

  async createFromQuote(
    userAddress: string,
    quoteId: string,
    userPaymentMethod?: string,
  ) {
    const quote = await this.prisma.quote.findUnique({ where: { id: quoteId } });
    if (!quote) throw new NotFoundException('quote not found');
    if (quote.userAddress !== userAddress) throw new ForbiddenException('quote does not belong to you');
    if (new Date() > quote.expiresAt) throw new BadRequestException('quote expired');

    const flow = quote.flow as Flow;
    if (flow === 'WITHDRAW' && !userPaymentMethod) {
      throw new BadRequestException('userPaymentMethod is required for WITHDRAW');
    }

    const config = await this.getConfig();
    if (config.paused) throw new ServiceUnavailableException('platform is paused');
    if (quote.usdcAmount < config.minOrder || quote.usdcAmount > config.maxOrder) {
      throw new BadRequestException('quote amount is outside current limits');
    }

    const personId = await this.userReputation.personIdFor(userAddress);
    const { tier } = await this.userReputation.getReputation(personId);
    const limitBase = this.userReputation.dailyLimitBaseUnits(tier, config);
    const used = await this.userReputation.used24hBaseUnits(personId);
    if (used + quote.usdcAmount > limitBase) {
      throw new BadRequestException('daily limit exceeded');
    }

    await this.assertIdentityVerified(personId, this.prisma);

    await this.markets.getEnabled(quote.fiatCurrency);

    const { payDeadline, confirmDeadline, disputeDeadline, expiresAt } = computeWindows(config);

    const platformWallet = config.platformWallet || this.cfg.platformWallet;

    const tradeId = newTradeId();

    const rail = quote.rail as 'BANK' | 'QRIS' | 'EWALLET';

    const lp = await this.matching.pickLp(rail, quote.fiatCurrency, quote.usdcAmount, personId);
    const lpBond = lp.staked;

    const roles = mapRoles(flow, userAddress, lp.stellarAddress);

    const userPaymentDetails = flow === 'WITHDRAW' ? userPaymentMethod : undefined;

    const releaseRecipients = Array.from(
      new Set([roles.usdcRecipient, platformWallet, lp.stellarAddress]),
    );
    const trust = await Promise.all(
      releaseRecipients.map((a) => this.stellar.hasUsdcTrustline(a)),
    );
    const missing = releaseRecipients.filter((_, i) => !trust[i]);
    if (missing.includes(roles.usdcRecipient) && roles.usdcRecipient === userAddress) {
      throw new BadRequestException(
        'Add a USDC trustline to your wallet before ordering — you need it to receive USDC.',
      );
    }
    if (missing.length > 0) {
      throw new ServiceUnavailableException(
        'A settlement wallet is not ready to receive USDC — please try again shortly.',
      );
    }

    const needsRef = flow === 'TOP_UP';

    const orderData = {
      tradeId,
      contractId: this.cfg.escrowContractId,
      userAddress,
      personId,
      lpId: lp.id,
      flow: quote.flow,
      rail: quote.rail,
      usdcAmount: quote.usdcAmount,
      fiatAmount: quote.fiatAmount,

      fiatCurrency: quote.fiatCurrency,
      rateSnapshot: quote.rateSnapshot,
      platformFeeBps: quote.platformFeeBps,
      lpFeeBps: quote.lpFeeBps,

      spreadBps: config.spreadBps,
      platformWallet,
      lpWallet: lp.stellarAddress,
      paymentMethodId: lp.paymentMethodId,
      lpPaymentDetails: lp.details,
      userPaymentDetails: userPaymentDetails ?? null,
      status: 'MATCHED' as const,
      payDeadline: BigInt(payDeadline),
      confirmDeadline: BigInt(confirmDeadline),
      disputeDeadline: BigInt(disputeDeadline),
      expiresAt,
    };

    const maxAttempts = needsRef ? MAX_REF_ATTEMPTS : 1;
    let order: any;
    for (let attempt = 0; ; attempt++) {
      try {
        order = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${personId}))`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LP_CAPACITY_LOCK_NAMESPACE}, hashtext(${lp.id}))`;

          const committed = await lpExposure(tx, lp.id, Math.floor(Date.now() / 1000));
          if (committed + quote.usdcAmount > lpBond) {
            this.log.warn(
              `match refused: lp ${lp.id} is committed ${committed} of ${lpBond} and cannot take ${quote.usdcAmount}`,
            );
            throw new ServiceUnavailableException('no eligible LP available');
          }

          const used = await this.userReputation.used24hBaseUnits(personId, tx);
          if (used + quote.usdcAmount > limitBase) {
            throw new BadRequestException('daily limit exceeded');
          }

          await this.assertIdentityVerified(personId, tx);

          const consumed = await tx.quote.updateMany({
            where: { id: quoteId, usedAt: null },
            data: { usedAt: new Date() },
          });
          if (consumed.count === 0) throw new ConflictException('quote already used');

          return this.createOrderRow(orderData, needsRef, tx);
        });
        break;
      } catch (e) {
        const isRefCollision =
          needsRef && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
        if (!isRefCollision) throw e;
        if (attempt + 1 >= maxAttempts) {
          throw new ServiceUnavailableException(
            'could not generate a unique transfer reference, please retry',
          );
        }
      }
    }

    const createTradeParams = buildCreateTradeParams(order, roles);

    const userIsSigner = flow !== 'TOP_UP';

    return {
      order: serializeOrderBase(order),
      create_trade_params: userIsSigner ? createTradeParams : undefined,
    };
  }

  async getOrder(id: string, callerAddress: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    if (!isUser && !isLp) throw new ForbiddenException('not your order');

    const currentOrder = await this.status.refreshOrderStatus(id, order);

    const isFundedOrLater = FUNDED_OR_LATER.includes(currentOrder.status);
    const fiatPayer = currentOrder.lp
      ? getFiatPayer(currentOrder.flow as Flow, currentOrder.userAddress, currentOrder.lp.stellarAddress)
      : undefined;
    const mayReveal = isFundedOrLater && fiatPayer !== undefined && callerAddress === fiatPayer;
    const shouldReveal =
      mayReveal &&
      (await this.identityVerified(currentOrder.personId, this.prisma));

    const config = await this.getConfig();
    const serialized = serializeOrderBase(currentOrder, config);
    if (shouldReveal) {
      serialized.payment_instructions = getPaymentInstructions(currentOrder);
    } else if (mayReveal) {
      serialized.payment_instructions_withheld = 'kyc_required';
    }

    if (currentOrder.lpId && currentOrder.lp) {
      serialized.lp_reputation = await this.getLpReputation(currentOrder.lpId, currentOrder.lp);
    }

    return serialized;
  }

  async listOrders(userAddress: string, page: { take: number; skip: number } = { take: 50, skip: 0 }) {
    const orders = await this.prisma.order.findMany({
      where: { userAddress },
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip,
    });
    const config = await this.getConfig();

    return orders.map((o) => serializeOrderBase(o, config));
  }

  async cancelOrder(id: string, callerAddress: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    if (!isUser && !isLp) throw new ForbiddenException('not your order');

    let currentStatus = order.status;
    if (REFRESH_FROM_CHAIN_STATUSES.includes(order.status)) {
      let onChain;
      try {
        onChain = await this.stellar.getTradeStatusStrict(this.status.contractIdFor(order), order.tradeId);
      } catch {
        throw new HttpException(
          'cannot verify on-chain status, retry',
          HttpStatus.CONFLICT,
        );
      }
      if (onChain && this.status.tradeBindsToOrder(onChain, order) && isAhead(onChain.status, order.status)) {
        const updated = await this.prisma.order.update({
          where: { id },
          data: { status: onChain.status as any, ...settlementFieldsFrom(onChain) },
          include: { lp: true },
        });
        currentStatus = updated.status;
      }
    }

    if (!PRE_CHAIN_STATUSES.includes(currentStatus)) {
      throw new ConflictException('cannot cancel order at this stage');
    }

    const res = await this.prisma.order.updateMany({
      where: { id, status: { in: PRE_CHAIN_STATUSES as any[] } },
      data: { status: 'CANCELLED' },
    });
    if (res.count === 0) {
      throw new ConflictException('cannot cancel order at this stage');
    }
    const updated = await this.prisma.order.findUnique({ where: { id } });

    try {
      await this.notifications.notifyOrderStatus(updated as any, 'CANCELLED');
    } catch (err) {
      this.log.warn(
        `cancelOrder: notify failed for order ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return serializeOrderBase(updated!);
  }

  async postDispute(
    orderId: string,
    callerAddress: string,
    reason: string,
    note: string,
    evidenceUrl: string | undefined,
  ): Promise<{ order: Record<string, any>; dispute_tx: { xdr: string; networkPassphrase: string } }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    if (!isUser && !isLp) {
      throw new ForbiddenException('only a trade party may open a dispute for this order');
    }
    const role: 'user' | 'lp' = isUser ? 'user' : 'lp';

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);
    const config = await this.getConfig();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'a dispute can only be opened while FIAT_PAID or within the post-settlement dispute window',
      );
    }

    if (currentOrder.disputeBy) {
      throw new ConflictException('a dispute has already been filed for this order');
    }

    const allowed = allowedDisputeReasons(currentOrder.flow);
    if (!allowed.includes(reason)) {
      throw new BadRequestException(
        `invalid reason for a ${currentOrder.flow} order — allowed: ${allowed.join(', ')}`,
      );
    }

    const sanitizedNote = note.trim();
    if (!sanitizedNote) {
      throw new BadRequestException('note must not be empty');
    }

    if (evidenceUrl !== undefined) {
      if (!isOwnEvidencePath(evidenceUrl, orderId, role)) {
        throw new BadRequestException(
          "evidenceUrl must be your OWN uploaded dispute evidence for this order (use POST /orders/:id/dispute-evidence first)",
        );
      }
      const exists = await this.storage.statObject(evidenceUrl);
      if (!exists) {
        throw new BadRequestException('evidenceUrl does not reference an uploaded file — upload it first');
      }
    }

    const claimed = await this.prisma.order.updateMany({
      where: { id: orderId, disputeBy: null },
      data: {
        disputeBy: role,
        disputeReason: reason,
        disputeNote: sanitizedNote,
        disputeEvidenceUrl: evidenceUrl ?? null,
        disputeAt: currentOrder.disputeAt ?? new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('a dispute has already been filed for this order');
    }

    const updated = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });

    const dispute_tx = await this.tx.buildRaiseDisputeTx(orderId, callerAddress);

    return { order: serializeOrderBase(updated, config), dispute_tx };
  }

  async listLpAssignments(lpAddress: string) {
    const lp = await this.prisma.lp.findUnique({ where: { stellarAddress: lpAddress } });
    if (!lp) throw new NotFoundException('LP not found');

    const orders = await this.prisma.order.findMany({
      where: {
        lpId: lp.id,
        status: { in: ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID'] },
      },
      orderBy: { createdAt: 'asc' },
    });

    const mapOne = async (order: any) => {
      const currentOrder = await this.status.refreshOrderStatus(order.id, order);

      const flow = currentOrder.flow as Flow;
      const roles = mapRoles(flow, currentOrder.userAddress, lpAddress);
      const createTradeParams = buildCreateTradeParams(currentOrder, roles);
      const lpIsSigner = flow === 'TOP_UP';

      const serialized = serializeOrderBase(currentOrder);
      const fiatPayer = getFiatPayer(flow, currentOrder.userAddress, lpAddress);
      if (
        fiatPayer === lpAddress &&
        FUNDED_OR_LATER.includes(currentOrder.status) &&
        (await this.identityVerified(currentOrder.personId, this.prisma))
      ) {
        serialized.payment_instructions = getPaymentInstructions(currentOrder);
      }

      return {
        order: serialized,
        create_trade_params: lpIsSigner ? createTradeParams : undefined,
      };
    };

    const results: any[] = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < orders.length; i += CONCURRENCY) {
      results.push(...(await Promise.all(orders.slice(i, i + CONCURRENCY).map(mapOne))));
    }

    const config = await this.getConfig();
    return results.map((r) => ({ ...r, require_proof: config?.requireProof ?? false }));
  }

  private async createOrderRow(
    data: Record<string, any>,
    needsRef: boolean,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (!needsRef) {
      return client.order.create({ data } as any);
    }
    return client.order.create({ data: { ...data, ref: generateRef() } } as any);
  }

  private configCache = new ConfigCache();
  private getConfig() {
    return this.configCache.read(this.prisma, this.cfg.platformWallet);
  }
}

export function computeWindows(config: {
  payWindowSecs: number;
  confirmWindowSecs: number;
  disputeWindowSecs: number;
}): { payDeadline: number; confirmDeadline: number; disputeDeadline: number; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const payDeadline = now + config.payWindowSecs;
  const confirmDeadline = payDeadline + config.confirmWindowSecs;
  const disputeDeadline = confirmDeadline + config.disputeWindowSecs;
  const expiresAt = new Date(signingDeadlineSecs(payDeadline) * 1000);
  return { payDeadline, confirmDeadline, disputeDeadline, expiresAt };
}

function getPaymentInstructions(order: any): string | undefined {
  if (order.flow === 'TOP_UP') {
    return order.lpPaymentDetails ?? undefined;
  }
  return order.userPaymentDetails ?? undefined;
}

function buildCreateTradeParams(
  order: any,
  roles: { usdcProvider: string; usdcRecipient: string; confirmer: string },
): CreateTradeParams {
  return {
    trade_id: order.tradeId,
    usdc_provider: roles.usdcProvider,
    usdc_recipient: roles.usdcRecipient,
    confirmer: roles.confirmer,
    usdc_amount: order.usdcAmount.toString(),
    pay_deadline: Number(order.payDeadline),
    confirm_deadline: Number(order.confirmDeadline),
    dispute_deadline: Number(order.disputeDeadline),
    platform_wallet: order.platformWallet,
    platform_fee_bps: order.platformFeeBps,
    lp_fee_bps: order.lpFeeBps,
  };
}

