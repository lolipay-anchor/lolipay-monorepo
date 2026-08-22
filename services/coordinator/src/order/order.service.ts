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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { MatchingService } from '../matching/matching.service';
import { AppConfigService } from '../config/app-config.service';
import { MarketsService } from '../market/markets.service';
import { NotificationService } from '../notification/notification.service';
import { mapRoles, newTradeId, contractIdFor, Flow } from './order.params';
import { verifyTradeMatchesOrder } from './trade-binding';
import { TradeOnChain } from '../stellar/stellar-read.types';
import { generateRef } from './ref.util';
import { quoteUsdcForFiat } from '../money/money';
import {
  sniffFileType,
  newProofKey,
  deterministicKey,
  EXT_CONTENT_TYPE,
  UploadedFileLike,
} from './upload.util';
import { canDispute, allowedDisputeReasons, isOwnEvidencePath, postSettleDisputeDeadline } from './dispute.util';
import { RateService } from '../rate/rate.service';
import { UploadProofDto } from './dto/upload-proof.dto';
import { ObjectStorageService } from '../storage/object-storage.service';
import { UserReputationService } from '../reputation/user-reputation.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

const CONFIG_TTL_MS = 5000;

export const MAX_REF_ATTEMPTS = 5;

const PRE_CHAIN_STATUSES = ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN'];

const NOT_YET_BOUND_ON_CHAIN = ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'EXPIRED'];

const REFRESH_FROM_CHAIN_STATUSES = [
  'MATCHED',
  'AWAITING_ONCHAIN',
  'FUNDED',
  'FIAT_PAID',
  'DISPUTED',
];

const FUNDED_OR_LATER = ['FUNDED', 'FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED'];

const STATUS_ORDER = [
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
    private realtime?: RealtimeGateway,

    private rate?: RateService,
  ) {}

  private repCache = new Map<string, { val: Record<string, any>; at: number }>();
  private static REP_TTL_MS = 60_000;

  async getLpReputation(
    lpId: string,
    lp: { online: boolean; approvedAt: Date | null; createdAt: Date },
  ): Promise<Record<string, any>> {
    const now = Date.now();
    const cached = this.repCache.get(lpId);
    if (cached && now - cached.at < OrderService.REP_TTL_MS) {
      return { ...cached.val, online: lp.online };
    }

    const [completed, refunded] = await Promise.all([
      this.prisma.order.count({ where: { lpId, status: 'RELEASED' } }),
      this.prisma.order.count({
        where: { lpId, status: 'REFUNDED', flow: 'WITHDRAW' },
      }),
    ]);
    const concluded = completed + refunded;
    const val = {
      completed_trades: completed,
      completion_rate: concluded > 0 ? completed / concluded : null,
      member_since: (lp.approvedAt ?? lp.createdAt).toISOString(),
    };
    this.repCache.set(lpId, { val, at: now });
    return { ...val, online: lp.online };
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

    const { tier } = await this.userReputation.getReputation(userAddress);
    const limitBase = this.userReputation.dailyLimitBaseUnits(tier, config);
    const used = await this.userReputation.used24hBaseUnits(userAddress);
    if (used + quote.usdcAmount > limitBase) {
      throw new BadRequestException('daily limit exceeded');
    }

    await this.markets.getEnabled(quote.fiatCurrency);

    const { payDeadline, confirmDeadline, disputeDeadline, expiresAt } = computeWindows(config);

    const platformWallet = config.platformWallet || this.cfg.platformWallet;

    const tradeId = newTradeId();

    const rail = quote.rail as 'BANK' | 'QRIS' | 'EWALLET';

    const lp = await this.matching.pickLp(rail, quote.fiatCurrency);

    if (lp.stellarAddress === userAddress) {
      throw new ForbiddenException('you cannot be matched with your own order');
    }

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
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userAddress}))`;

          const used = await this.userReputation.used24hBaseUnits(userAddress, tx);
          if (used + quote.usdcAmount > limitBase) {
            throw new BadRequestException('daily limit exceeded');
          }

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

    const currentOrder = await this.refreshOrderStatus(id, order);

    const isFundedOrLater = FUNDED_OR_LATER.includes(currentOrder.status);
    const fiatPayer = currentOrder.lp
      ? getFiatPayer(currentOrder.flow as Flow, currentOrder.userAddress, currentOrder.lp.stellarAddress)
      : undefined;
    const shouldReveal = isFundedOrLater && fiatPayer !== undefined && callerAddress === fiatPayer;

    const config = await this.getConfig();
    const serialized = serializeOrderBase(currentOrder, config);
    if (shouldReveal) {
      serialized.payment_instructions = getPaymentInstructions(currentOrder);
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
        onChain = await this.stellar.getTradeStatusStrict(this.contractIdFor(order), order.tradeId);
      } catch {
        throw new HttpException(
          'cannot verify on-chain status, retry',
          HttpStatus.CONFLICT,
        );
      }
      if (onChain && this.tradeBindsToOrder(onChain, order) && isAhead(onChain.status, order.status)) {
        const updated = await this.prisma.order.update({
          where: { id },
          data: { status: onChain.status as any },
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

  async buildMarkFiatPaidTx(
    orderId: string,
    callerAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const lp = this.requireLp(order);
    const fiatPayer = getFiatPayer(order.flow as Flow, order.userAddress, lp.stellarAddress);
    if (callerAddress !== fiatPayer) {
      throw new ForbiddenException('only the fiat payer may build this transaction');
    }

    const currentOrder = await this.refreshOrderStatus(orderId, order);

    if (currentOrder.status !== 'FUNDED') {
      throw new ConflictException('order must be in FUNDED status to mark fiat paid');
    }

    if (order.flow !== 'TOP_UP') {
      const config = await this.getConfig();
      if (config.requireProof && !currentOrder.proofUrl) {
        throw new BadRequestException('payment proof required before marking paid');
      }
    }

    try {
      return await this.stellar.buildMarkFiatPaidTx(
        this.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildMarkFiatPaidTx error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildCreateTradeTx(
    orderId: string,
    callerAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const lp = this.requireLp(order);
    const flow = order.flow as Flow;
    const roles = mapRoles(flow, order.userAddress, lp.stellarAddress);

    if (callerAddress !== roles.usdcProvider) {
      throw new ForbiddenException('only the usdc_provider may build this transaction');
    }

    const currentOrder = await this.refreshOrderStatus(orderId, order);

    const preChainCreateStatuses = ['MATCHED', 'AWAITING_ONCHAIN'];
    if (!preChainCreateStatuses.includes(currentOrder.status)) {
      throw new ConflictException(
        `order must be in ${preChainCreateStatuses.join(' or ')} status to build create_trade`,
      );
    }

    try {
      return await this.stellar.buildCreateTradeTx({
        contractId: this.contractIdFor(currentOrder),
        tradeIdHex: currentOrder.tradeId,
        usdcProvider: roles.usdcProvider,
        usdcRecipient: roles.usdcRecipient,
        confirmer: roles.confirmer,
        usdcAmount: currentOrder.usdcAmount,
        fiatAmount: currentOrder.fiatAmount,
        fiatCurrency: currentOrder.fiatCurrency,
        flow: currentOrder.flow,
        platformFeeBps: currentOrder.platformFeeBps,
        lpFeeBps: currentOrder.lpFeeBps,
        platformWallet: currentOrder.platformWallet,

        lpWallet: currentOrder.lpWallet ?? lp.stellarAddress,
        payDeadline: currentOrder.payDeadline,
        confirmDeadline: currentOrder.confirmDeadline,
        disputeDeadline: currentOrder.disputeDeadline,
      });
    } catch (err) {
      console.error('buildCreateTradeTx error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildConfirmReleaseTx(
    orderId: string,
    callerAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const lp = this.requireLp(order);
    const flow = order.flow as Flow;
    const roles = mapRoles(flow, order.userAddress, lp.stellarAddress);

    if (callerAddress !== roles.confirmer) {
      throw new ForbiddenException('only the confirmer may build this transaction');
    }

    const currentOrder = await this.refreshOrderStatus(orderId, order);

    if (currentOrder.status !== 'FIAT_PAID') {
      throw new ConflictException('order must be in FIAT_PAID status to confirm release');
    }

    try {
      return await this.stellar.buildConfirmReleaseTx(
        this.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildConfirmReleaseTx error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildRaiseDisputeTx(
    orderId: string,
    callerAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const isParty =
      callerAddress === order.userAddress || callerAddress === order.lp?.stellarAddress;
    if (!isParty) throw new ForbiddenException('only a trade party may raise a dispute');

    const currentOrder = await this.refreshOrderStatus(orderId, order);
    const config = await this.getConfig();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'a dispute can only be raised while FIAT_PAID or within the post-settlement dispute window',
      );
    }
    try {
      return await this.stellar.buildRaiseDisputeTx(
        this.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildRaiseDisputeTx error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildResolveTx(
    orderId: string,
    callerAddress: string,
    outcome: 'release' | 'refund',
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const currentOrder = await this.refreshOrderStatus(orderId, order);
    if (currentOrder.status !== 'DISPUTED') {
      throw new ConflictException('order is not in DISPUTED status');
    }
    try {
      return await this.stellar.buildResolveTx(
        this.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
        outcome,
      );
    } catch (err) {
      console.error('buildResolveTx error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async uploadProof(
    orderId: string,
    callerAddress: string,
    file: UploadedFileLike | undefined,
    meta: UploadProofDto = {},
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    if (order.flow === 'TOP_UP') {
      throw new BadRequestException(
        'payment proof upload does not apply to TOP_UP orders — the user pays fiat there, not the LP',
      );
    }

    const lp = this.requireLp(order);
    if (callerAddress !== lp.stellarAddress) {
      throw new ForbiddenException('only the assigned LP may upload payment proof for this order');
    }

    const currentOrder = await this.refreshOrderStatus(orderId, order);
    if (currentOrder.status !== 'FUNDED') {
      throw new ConflictException('order must be FUNDED to upload payment proof');
    }

    const rrn = meta.rrn ? meta.rrn.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null;

    let proofAmount: bigint | null = null;
    if (meta.paidAmount != null) {
      if (!/^[1-9][0-9]{0,14}$/.test(meta.paidAmount)) {
        throw new BadRequestException('paidAmount must be a positive integer (base units)');
      }
      proofAmount = BigInt(meta.paidAmount);
    }
    const proofPaidAt = meta.paidAt != null ? new Date(meta.paidAt) : null;
    if (proofPaidAt && Number.isNaN(proofPaidAt.getTime())) {
      throw new BadRequestException('paidAt must be a valid timestamp');
    }

    if (proofPaidAt) {
      if (proofPaidAt.getTime() > Date.now() + 5 * 60_000) {
        throw new BadRequestException('payment time cannot be in the future');
      }
      if (proofPaidAt.getTime() < new Date(order.createdAt).getTime()) {
        throw new BadRequestException('payment time cannot predate the order');
      }
    }

    if (rrn) {
      const clash = await this.prisma.order.findFirst({
        where: { proofRrn: rrn, lpId: order.lpId, id: { not: orderId } },
        select: { id: true },
      });
      if (clash) {
        throw new ConflictException('this payment reference has already been used for another order');
      }
    }

    const previousProofUrl: string | null = currentOrder.proofUrl ?? null;

    const relativePath = await this.sniffAndStore(file, 'proofs');

    let claimed: { count: number };
    try {
      claimed = await this.prisma.order.updateMany({
        where: { id: orderId, status: 'FUNDED', proofUrl: previousProofUrl },
        data: {
          proofUrl: relativePath,
          proofUploadedAt: new Date(),
          proofRrn: rrn,
          proofAmount,
          proofPaidAt,
        },
      });
    } catch (e) {
      await this.storage.removeObject(relativePath);
      if ((e as { code?: string })?.code === 'P2002') {
        throw new ConflictException('this payment reference has already been used for another order');
      }
      throw e;
    }
    if (claimed.count === 0) {
      await this.storage.removeObject(relativePath);
      throw new ConflictException('order must be FUNDED to upload payment proof');
    }

    if (previousProofUrl) await this.storage.removeObject(previousProofUrl);

    const updated = await this.prisma.order.findUnique({ where: { id: orderId } });
    return serializeOrderBase(updated!);
  }

  async getProofFile(
    orderId: string,
    callerAddress: string,
  ): Promise<{ key: string; contentType: string; ext: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    const isAdmin = this.cfg.adminAddresses.includes(callerAddress);
    if (!isUser && !isLp && !isAdmin) {
      throw new ForbiddenException('not authorized to view this order’s payment proof');
    }

    if (!order.proofUrl) throw new NotFoundException('no payment proof uploaded for this order');

    const ext = order.proofUrl.split('.').pop() ?? '';
    const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
    return { key: order.proofUrl, contentType, ext };
  }

  async getDisputeEvidenceFile(
    orderId: string,
    callerAddress: string,
  ): Promise<{ key: string; contentType: string; ext: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    const isAdmin = this.cfg.adminAddresses.includes(callerAddress);
    if (!isUser && !isLp && !isAdmin) {
      throw new ForbiddenException('not authorized to view this order’s dispute evidence');
    }

    if (!order.disputeEvidenceUrl) throw new NotFoundException('no dispute evidence uploaded for this order');

    const ext = order.disputeEvidenceUrl.split('.').pop() ?? '';
    const contentType = EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream';
    return { key: order.disputeEvidenceUrl, contentType, ext };
  }

  async uploadDisputeEvidence(
    orderId: string,
    callerAddress: string,
    file: UploadedFileLike | undefined,
  ): Promise<{ evidence_url: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { lp: true } });
    if (!order) throw new NotFoundException('order not found');

    const isUser = order.userAddress === callerAddress;
    const isLp = order.lp?.stellarAddress === callerAddress;
    if (!isUser && !isLp) {
      throw new ForbiddenException('only a trade party may upload dispute evidence for this order');
    }

    const currentOrder = await this.refreshOrderStatus(orderId, order);
    const config = await this.getConfig();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'dispute evidence can only be uploaded while FIAT_PAID or within the post-settlement dispute window',
      );
    }

    const role: 'user' | 'lp' = isUser ? 'user' : 'lp';
    const relativePath = await this.sniffAndStoreDeterministic(file, `${orderId}-${role}`);
    return { evidence_url: relativePath };
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

    const currentOrder = await this.refreshOrderStatus(orderId, order);
    const config = await this.getConfig();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'a dispute can only be opened while FIAT_PAID or within the post-settlement dispute window',
      );
    }

    const isRefill = currentOrder.disputeBy === role && currentOrder.disputeReason === null;
    if (currentOrder.disputeBy && !isRefill) {
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
      where: isRefill
        ? { id: orderId, disputeBy: role, disputeReason: null }
        : { id: orderId, disputeBy: null },
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

    const dispute_tx = await this.buildRaiseDisputeTx(orderId, callerAddress);

    return { order: serializeOrderBase(updated, config), dispute_tx };
  }

  private async sniffAndStore(
    file: UploadedFileLike | undefined,
    kind: 'proofs' | 'evidence',
  ): Promise<string> {
    const sniffed = this.sniffOrThrow(file);
    const key = newProofKey(kind, sniffed.ext);
    try {
      await this.storage.putObject(key, file!.buffer, sniffed.mime);
    } catch {
      throw new ServiceUnavailableException('could not store the uploaded file, retry');
    }
    return key;
  }

  private async sniffAndStoreDeterministic(
    file: UploadedFileLike | undefined,
    key: string,
  ): Promise<string> {
    const sniffed = this.sniffOrThrow(file);
    const objectKey = deterministicKey('evidence', key, sniffed.ext);
    try {
      await this.storage.putObject(objectKey, file!.buffer, sniffed.mime);
    } catch {
      throw new ServiceUnavailableException('could not store the uploaded file, retry');
    }
    await Promise.all(
      Object.keys(EXT_CONTENT_TYPE)
        .filter((ext) => ext !== sniffed.ext)
        .map((ext) => this.storage.removeObject(deterministicKey('evidence', key, ext))),
    );
    return objectKey;
  }

  private sniffOrThrow(file: UploadedFileLike | undefined): { mime: string; ext: string } {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BadRequestException('a file is required');
    }
    const sniffed = sniffFileType(file.buffer);
    if (!sniffed) {
      throw new BadRequestException('unsupported or unrecognized file type (allowed: jpg, png, webp, pdf)');
    }
    if (file.mimetype !== sniffed.mime) {
      throw new BadRequestException('file content does not match its declared Content-Type');
    }
    return sniffed;
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
      let currentOrder = order;
      if (REFRESH_FROM_CHAIN_STATUSES.includes(order.status)) {
        const onChain = await this.stellar.getTradeStatus(this.contractIdFor(order), order.tradeId);
        if (onChain && this.tradeBindsToOrder(onChain, order) && isAhead(onChain.status, order.status)) {
          currentOrder = await this.prisma.order.update({
            where: { id: order.id },
            data: { status: onChain.status as any },
          });
        }
      }

      const flow = currentOrder.flow as Flow;
      const roles = mapRoles(flow, currentOrder.userAddress, lpAddress);
      const createTradeParams = buildCreateTradeParams(currentOrder, roles);
      const lpIsSigner = flow === 'TOP_UP';

      const serialized = serializeOrderBase(currentOrder);
      const fiatPayer = getFiatPayer(flow, currentOrder.userAddress, lpAddress);
      if (fiatPayer === lpAddress && FUNDED_OR_LATER.includes(currentOrder.status)) {
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

  private tradeBindsToOrder(onChain: TradeOnChain, order: any): boolean {
    if (!NOT_YET_BOUND_ON_CHAIN.includes(order.status)) return true;

    const mismatches = verifyTradeMatchesOrder(onChain, order);
    if (mismatches.length === 0) return true;

    this.log.error(
      `order ${order.id} (tradeId ${order.tradeId}): REFUSING to bind — the on-chain trade does not match the order. ${mismatches.join(' | ')}`,
    );
    return false;
  }

  private async refreshOrderStatus(id: string, order: any): Promise<any> {
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

  private contractIdFor(order: { contractId?: string | null }): string {
    return contractIdFor(order, this.cfg);
  }

  private requireLp<T extends { stellarAddress: string }>(order: { lp: T | null }): T {
    if (!order.lp) {
      throw new ConflictException('order has no matched LP yet');
    }
    return order.lp;
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

  private configCache: { row: any; at: number } | null = null;
  private async getConfig() {
    const now = Date.now();
    if (this.configCache && now - this.configCache.at < CONFIG_TTL_MS) {
      return this.configCache.row;
    }
    const row = await this.prisma.config.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, platformWallet: this.cfg.platformWallet },
    });
    this.configCache = { row, at: now };
    return row;
  }
}

function isAhead(newStatus: string, currentStatus: string): boolean {
  const newIdx = STATUS_ORDER.indexOf(newStatus);
  const curIdx = STATUS_ORDER.indexOf(currentStatus);
  return newIdx > curIdx;
}

function computeWindows(config: {
  payWindowSecs: number;
  confirmWindowSecs: number;
  disputeWindowSecs: number;
}): { payDeadline: number; confirmDeadline: number; disputeDeadline: number; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const payDeadline = now + config.payWindowSecs;
  const confirmDeadline = payDeadline + config.confirmWindowSecs;
  const disputeDeadline = confirmDeadline + config.disputeWindowSecs;
  const expiresAt = new Date(payDeadline * 1000);
  return { payDeadline, confirmDeadline, disputeDeadline, expiresAt };
}

function getFiatPayer(flow: Flow, user: string, lpAddress: string): string {
  return flow === 'TOP_UP' ? user : lpAddress;
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

function serializeOrderBase(
  order: any,
  config?: { postSettleDisputeWindowSecs: number } | null,
): Record<string, any> {
  return {
    id: order.id,
    trade_id: order.tradeId,
    user_address: order.userAddress,
    lp_wallet: order.lpWallet,
    flow: order.flow,
    rail: order.rail,
    usdc_amount: order.usdcAmount.toString(),
    fiat_amount: order.fiatAmount.toString(),
    fiat_currency: order.fiatCurrency,
    rate_snapshot: order.rateSnapshot,
    platform_fee_bps: order.platformFeeBps,
    lp_fee_bps: order.lpFeeBps,
    status: order.status,
    pay_deadline: Number(order.payDeadline),
    confirm_deadline: Number(order.confirmDeadline),
    dispute_deadline: Number(order.disputeDeadline),
    expires_at: order.expiresAt,
    created_at: order.createdAt,

    ref: order.ref ?? null,
    proof_url: order.proofUrl ?? null,

    proof_rrn: order.proofRrn ?? null,
    proof_amount: order.proofAmount != null ? order.proofAmount.toString() : null,
    proof_paid_at: order.proofPaidAt ?? null,
      settled_at: order.settledAt ?? null,
    dispute_by: order.disputeBy ?? null,
    dispute_reason: order.disputeReason ?? null,
    dispute_note: order.disputeNote ?? null,
    dispute_evidence_url: order.disputeEvidenceUrl ?? null,
    dispute_at: order.disputeAt ?? null,
    resolution: order.resolution ?? null,

    post_settle_dispute_until: config ? postSettleDisputeDeadline(order, config) : null,
  };
}
