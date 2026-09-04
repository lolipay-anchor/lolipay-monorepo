import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { refundOpensAt } from '../order/dispute.util';
import { LpStatus, Market, OrderStatus, Prisma } from '../generated/prisma/client';
import { StrKey } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { PersonId } from '../person/person.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { recordAudit, auditPayload } from './admin-audit';
import { windowsFitTheContract } from '../config/contract-limits';
import { spreadCoversPriceDeviation, platformFeeFitsSpread } from '../config/rate-guard';
import { invalidateAllConfigCaches } from '../config/config-cache';
import { AppConfigService } from '../config/app-config.service';
import { MarketsService } from '../market/markets.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { RegisterLpDto } from './dto/register-lp.dto';
import { UserReputationService, UserTierName } from '../reputation/user-reputation.service';
import { applyBps, baseUnitsToUsdc } from '../money/money';
import { MetricsRange } from './dto/metrics-overview-query.dto';
import { NotificationService } from '../notification/notification.service';
import { AttestorService } from '../stellar/attestor.service';
import { contractIdFor } from '../order/order.params';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const METRICS_RANGE_MS: Record<MetricsRange, number> = {
  '24h': DAY_MS,
  '7d': 7 * DAY_MS,
  '30d': 30 * DAY_MS,
};

export interface MetricsOverview {
  range: MetricsRange;
  volumeUsdc: number;
  feesUsdc: number;
  avgSettleSecs: number | null;
  openDisputes: number;
  ordersCount: number;
  dailyBars: { date: string; volumeUsdc: number }[];
  flowMix: { flow: string; count: number; volumeUsdc: number }[];
  topLps: { lpId: string; address: string | null; volumeUsdc: number; trades: number }[];
}

export interface OrderRisk {
  walletAgeDays: number | null;
  userDisputeVelocity30d: number;
  lpDisputeVelocity30d: number;
  amountVsTierLimit: {
    orderUsdc: number;
    tier: UserTierName;
    dailyLimitUsdc: number;
    ratio: number | null;
  };
  lpCompletion: {
    completed_trades: number;
    completion_rate: number | null;
    member_since: string;
    online: boolean;
  } | null;
}

@Injectable()
export class AdminService {
  private readonly log = new Logger('Admin');

  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private cfg: AppConfigService,
    private markets: MarketsService,
    private userReputation: UserReputationService,
    private attestor: AttestorService,
    private notifications: NotificationService,
  ) {}

  list(status?: LpStatus) {
    return this.prisma.lp.findMany({
      where: status ? { status } : {},
    });
  }

  async register(dto: RegisterLpDto, actorAddress: string) {
    if (!StrKey.isValidEd25519PublicKey(dto.stellarAddress)) {
      throw new BadRequestException(
        'Invalid Stellar address (bad checksum) — double-check the wallet key.',
      );
    }
    const existing = await this.prisma.lp.findUnique({
      where: { stellarAddress: dto.stellarAddress },
    });
    if (existing) {
      throw new ConflictException(
        'An LP with this wallet address already exists',
      );
    }

    const hasTrustline = await this.stellar.hasUsdcTrustline(dto.stellarAddress);
    if (!hasTrustline) {
      throw new BadRequestException(
        `This wallet has no trustline for ${this.cfg.usdcAssetCode} ` +
          `(issuer ${this.cfg.usdcAssetIssuer}), so it can't receive USDC. ` +
          `Ask the LP to add that exact trustline first.`,
      );
    }
    const approve = dto.approve !== false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.lp.create({
          data: {
            stellarAddress: dto.stellarAddress,
            contact: dto.contact,
            liquidityProof: dto.liquidityProof?.trim() || 'Registered by admin',
            status: approve ? LpStatus.APPROVED : LpStatus.PENDING,
            approvalNote: 'Registered by admin',
            approvedAt: approve ? new Date() : null,
          },
        });
        await recordAudit(tx as any, {
          actorAddress,
          action: 'lp.register',
          targetType: 'Lp',
          targetId: created.id,
          after: { status: created.status, stellarAddress: created.stellarAddress },
        });
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'An LP with this wallet address already exists',
        );
      }
      throw e;
    }
  }

  async setStatus(
    id: string,
    status: 'APPROVED' | 'SUSPENDED' | 'REVOKED',
    note: string | undefined,
    actorAddress: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const lp = await tx.lp.findUnique({ where: { id } });
      if (!lp) throw new NotFoundException();

      const updated = await tx.lp.update({
        where: { id },
        data: {
          status,
          approvalNote: note ?? lp.approvalNote,
          approvedAt: status === 'APPROVED' ? new Date() : lp.approvedAt,
        },
      });

      await recordAudit(tx as any, {
        actorAddress,
        action: 'lp.setStatus',
        targetType: 'Lp',
        targetId: id,
        before: { status: lp.status, approvalNote: lp.approvalNote },
        after: { status: updated.status, approvalNote: updated.approvalNote },
      });

      return updated;
    });
  }

  listOrders(
    status?: OrderStatus,
    page: { take: number; skip: number } = { take: 50, skip: 0 },
  ) {
    return this.prisma.order.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: page.take,
      skip: page.skip,
    });
  }

  config() {
    return this.prisma.config.findUnique({ where: { id: 1 } });
  }

  async updateConfigTransactional(patch: UpdateConfigDto, actorAddress: string) {
    if (patch.platformWallet !== undefined) {
      let chainWallet: string;
      try {
        chainWallet = await this.stellar.readEscrowPlatformWallet(this.cfg.escrowContractId);
      } catch {
        throw new Error(
          'PLATFORM_WALLET_DIVERGES_FROM_CHAIN: the escrow contract default_platform_wallet could not be read, so platformWallet cannot be checked against it',
        );
      }
      if (patch.platformWallet !== chainWallet) {
        throw new Error(
          `PLATFORM_WALLET_DIVERGES_FROM_CHAIN: platformWallet must equal the escrow contract default_platform_wallet (${chainWallet}), which the contract will not let anyone change, because create_trade refuses any other value and every funding would revert`,
        );
      }
    }
    let chainPlatformFeeBps: number | undefined;
    if (patch.platformFeeBps !== undefined) {
      try {
        chainPlatformFeeBps = await this.stellar.readEscrowPlatformFeeBps(this.cfg.escrowContractId);
      } catch {
        throw new Error(
          'PLATFORM_FEE_DIVERGES_FROM_CHAIN: the escrow contract default_platform_fee_bps could not be read, so platformFeeBps cannot be checked against it',
        );
      }
    }
    let deployedCooldownSecs: number | undefined;
    if (patch.payWindowSecs !== undefined || patch.confirmWindowSecs !== undefined) {
      try {
        deployedCooldownSecs = await this.stellar.stakingCooldownSecs();
      } catch {
        throw new Error(
          'WINDOW_BOUNDS_INVALID: the deployed staking cooldown could not be read, so these windows cannot be checked against it',
        );
      }
    }

    const committed = await this.prisma.$transaction(async (tx) => {
      const current = await tx.config.findUnique({ where: { id: 1 } });

      const effectivePlatformFee =
        patch.platformFeeBps !== undefined
          ? patch.platformFeeBps
          : (current?.platformFeeBps ?? 0);
      const effectiveLpFee =
        patch.lpFeeBps !== undefined ? patch.lpFeeBps : (current?.lpFeeBps ?? 0);

      if (effectivePlatformFee + effectiveLpFee >= 10000) {
        throw new Error('BPS_OVERFLOW');
      }


      const windowProblem = windowsFitTheContract(
        patch.payWindowSecs ?? current?.payWindowSecs ?? 0,
        patch.confirmWindowSecs ?? current?.confirmWindowSecs ?? 0,
        patch.disputeWindowSecs ?? current?.disputeWindowSecs ?? 0,
        deployedCooldownSecs,
      );
      if (windowProblem) {
        throw new Error(`WINDOW_BOUNDS_INVALID: ${windowProblem}`);
      }

      if (patch.spreadBps !== undefined) {
        const spreadProblem = spreadCoversPriceDeviation(
          patch.spreadBps,
          this.cfg.priceDeviationMaxBps,
        );
        if (spreadProblem) {
          throw new Error(`SPREAD_TOO_NARROW: ${spreadProblem}`);
        }
      }
      if (patch.platformFeeBps !== undefined || patch.spreadBps !== undefined) {
        const feeProblem = platformFeeFitsSpread(
          effectivePlatformFee,
          patch.spreadBps !== undefined ? patch.spreadBps : (current?.spreadBps ?? 0),
          this.cfg.priceDeviationMaxBps,
        );
        if (feeProblem) {
          throw new Error(`PLATFORM_FEE_EXCEEDS_SPREAD: ${feeProblem}`);
        }
      }
      if (chainPlatformFeeBps !== undefined && patch.platformFeeBps !== chainPlatformFeeBps) {
        throw new Error(
          `PLATFORM_FEE_DIVERGES_FROM_CHAIN: platformFeeBps (${patch.platformFeeBps}) must equal the escrow contract default_platform_fee_bps (${chainPlatformFeeBps}), because create_trade refuses any other value and every funding would revert`,
        );
      }

      const { minOrder: minOrderPatch, maxOrder: maxOrderPatch, ...rest } = patch;
      const nextMinOrder =
        minOrderPatch !== undefined ? BigInt(minOrderPatch) : (current?.minOrder ?? 0n);
      const nextMaxOrder =
        maxOrderPatch !== undefined ? BigInt(maxOrderPatch) : (current?.maxOrder ?? 0n);

      if (!(nextMinOrder < nextMaxOrder)) {
        throw new Error('ORDER_BOUNDS_INVALID');
      }

      const data: Prisma.ConfigUpdateInput = { ...rest };
      if (minOrderPatch !== undefined) data.minOrder = nextMinOrder;
      if (maxOrderPatch !== undefined) data.maxOrder = nextMaxOrder;

      const updated = await tx.config.update({ where: { id: 1 }, data });

      await recordAudit(tx as any, {
        actorAddress,
        action: 'config.update',
        targetType: 'Config',
        targetId: '1',
        before: auditPayload(current),
        after: auditPayload(updated),
      });

      return updated;
    });

    invalidateAllConfigCaches();
    return committed;
  }

  listMarkets(): Promise<Market[]> {
    return this.markets.list();
  }

  async updateMarket(code: string, patch: UpdateMarketDto, actorAddress: string): Promise<Market> {
    const before = await this.markets.get(code);
    const updated = await this.markets.update(code, patch as Prisma.MarketUncheckedUpdateInput);
    await recordAudit(this.prisma as any, {
      actorAddress,
      action: 'market.update',
      targetType: 'Market',
      targetId: code,
      before: auditPayload(before),
      after: auditPayload(updated),
    });
    return updated;
  }

  async getOrderRisk(id: string): Promise<OrderRisk> {
    const order = await this.prisma.order.findUnique({ where: { id }, include: { lp: true } });
    if (!order) throw new NotFoundException();

    const since30d = new Date(Date.now() - THIRTY_DAYS_MS);

    const [firstTxAt, userDisputeVelocity30d, lpDisputeVelocity30d, reputation, config] =
      await Promise.all([
        this.stellar.getAccountFirstTxAt(order.userAddress),
        this.prisma.order.count({
          where: { userAddress: order.userAddress, disputeAt: { gte: since30d } },
        }),
        order.lpId
          ? this.prisma.order.count({ where: { lpId: order.lpId, disputeAt: { gte: since30d } } })
          : Promise.resolve(0),
        this.userReputation.getReputation(order.personId as PersonId),
        this.config(),
      ]);

    const walletAgeDays =
      firstTxAt !== null
        ? Math.floor((Date.now() - new Date(firstTxAt).getTime()) / DAY_MS)
        : null;

    const dailyLimitBase = this.userReputation.dailyLimitBaseUnits(reputation.tier, config);
    const orderUsdc = baseUnitsToUsdc(order.usdcAmount);
    const dailyLimitUsdc = baseUnitsToUsdc(dailyLimitBase);

    const lpCompletion =
      order.lpId && order.lp ? await this.computeLpCompletion(order.lpId, order.lp) : null;

    return {
      walletAgeDays,
      userDisputeVelocity30d,
      lpDisputeVelocity30d,
      amountVsTierLimit: {
        orderUsdc,
        tier: reputation.tier,
        dailyLimitUsdc,
        ratio: dailyLimitUsdc > 0 ? orderUsdc / dailyLimitUsdc : null,
      },
      lpCompletion,
    };
  }

  private async computeLpCompletion(
    lpId: string,
    lp: { online: boolean; approvedAt: Date | null; createdAt: Date },
  ): Promise<{ completed_trades: number; completion_rate: number | null; member_since: string; online: boolean }> {
    const [completed, refunded] = await Promise.all([
      this.prisma.order.count({ where: { lpId, status: 'RELEASED' } }),
      this.prisma.order.count({
        where: { lpId, status: 'REFUNDED', flow: 'WITHDRAW' },
      }),
    ]);
    const concluded = completed + refunded;
    return {
      completed_trades: completed,
      completion_rate: concluded > 0 ? completed / concluded : null,
      member_since: (lp.approvedAt ?? lp.createdAt).toISOString(),
      online: lp.online,
    };
  }

  async getMetricsOverview(range: MetricsRange): Promise<MetricsOverview> {
    if (!(range in METRICS_RANGE_MS)) {
      throw new BadRequestException('range must be one of: 24h, 7d, 30d');
    }
    const since = new Date(Date.now() - METRICS_RANGE_MS[range]);
    const releasedInRange: Prisma.OrderWhereInput = {
      status: OrderStatus.RELEASED,
      settledAt: { gte: since },
    };

    const [feeRows, flowMixGrouped, topLpGrouped, openDisputes, dailyBarsRaw, avgSettleRaw] =
      await Promise.all([
        this.prisma.order.findMany({
          where: releasedInRange,
          select: { usdcAmount: true, platformFeeBps: true, lpFeeBps: true },
        }),
        this.prisma.order.groupBy({
          by: ['flow'],
          where: releasedInRange,
          _sum: { usdcAmount: true },
          _count: { _all: true },
        }),
        this.prisma.order.groupBy({
          by: ['lpId'],
          where: { ...releasedInRange, lpId: { not: null } },
          _sum: { usdcAmount: true },
          _count: { _all: true },
          orderBy: { _sum: { usdcAmount: 'desc' } },
          take: 5,
        }),
        this.prisma.order.count({ where: { status: OrderStatus.DISPUTED } }),

        this.prisma.$queryRaw<{ day: string; volume: string }[]>(Prisma.sql`
          SELECT to_char(date_trunc('day', "settledAt"), 'YYYY-MM-DD') AS day,
                 SUM("usdcAmount")::text AS volume
          FROM "Order"
          WHERE status = 'RELEASED' AND "settledAt" >= ${since}
          GROUP BY day
          ORDER BY day ASC
        `),
        this.prisma.$queryRaw<{ avg_secs: number | null }[]>(Prisma.sql`
          SELECT AVG(EXTRACT(EPOCH FROM ("settledAt" - "createdAt")))::float8 AS avg_secs
          FROM "Order"
          WHERE status = 'RELEASED' AND "settledAt" >= ${since}
        `),
      ]);

    let volumeBase = 0n;
    let feesBase = 0n;
    for (const o of feeRows) {
      volumeBase += o.usdcAmount;

      feesBase += applyBps(o.usdcAmount, o.platformFeeBps) + applyBps(o.usdcAmount, o.lpFeeBps);
    }

    const lpIds = topLpGrouped
      .map((g) => g.lpId)
      .filter((id): id is string => id != null);
    const lps = lpIds.length
      ? await this.prisma.lp.findMany({
          where: { id: { in: lpIds } },
          select: { id: true, stellarAddress: true },
        })
      : [];
    const addrById = new Map(lps.map((l) => [l.id, l.stellarAddress]));

    return {
      range,
      volumeUsdc: baseUnitsToUsdc(volumeBase),
      feesUsdc: baseUnitsToUsdc(feesBase),
      avgSettleSecs: avgSettleRaw[0]?.avg_secs ?? null,
      openDisputes,
      ordersCount: feeRows.length,
      dailyBars: dailyBarsRaw.map((row) => ({
        date: row.day,
        volumeUsdc: baseUnitsToUsdc(BigInt(row.volume)),
      })),
      flowMix: flowMixGrouped.map((g) => ({
        flow: g.flow,
        count: g._count._all,
        volumeUsdc: baseUnitsToUsdc(g._sum.usdcAmount ?? 0n),
      })),
      topLps: topLpGrouped.map((g) => ({
        lpId: g.lpId as string,
        address: g.lpId ? (addrById.get(g.lpId) ?? null) : null,
        volumeUsdc: baseUnitsToUsdc(g._sum.usdcAmount ?? 0n),
        trades: g._count._all,
      })),
    };
  }

  private readonly attesting = new Set<string>();

  async attestFiatPaid(orderId: string, actorAddress: string, evidence: string) {
    if (this.attesting.has(orderId)) {
      throw new ConflictException('an attestation for this order is already in flight');
    }
    this.attesting.add(orderId);
    try {
      return await this.attestFiatPaidOnce(orderId, actorAddress, evidence);
    } finally {
      this.attesting.delete(orderId);
    }
  }

  private async attestFiatPaidOnce(orderId: string, actorAddress: string, evidence: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, flow: true, status: true, tradeId: true, contractId: true, userAddress: true, lpWallet: true, settledAt: true, payDeadline: true, confirmDeadline: true },
    });
    if (!order) {
      throw new NotFoundException('no such order');
    }
    if (order.flow !== 'TOP_UP') {
      throw new BadRequestException(
        'only a top-up is attested by this anchor — on any other flow the fiat is sent by the provider, who marks it themselves',
      );
    }
    if (order.status !== 'FUNDED') {
      throw new ConflictException(
        `this order is ${order.status}; only a FUNDED top-up can be attested`,
      );
    }

    const contractId = contractIdFor(order, this.cfg);
    let outcome: { submission: string; txHash?: string; error?: string };
    let refusal: unknown;
    try {
      const result = await this.attestor.attest(contractId, order.tradeId, Number(refundOpensAt(order)));
      outcome = { submission: result.status, txHash: result.hash };
    } catch (err) {
      refusal = err;
      outcome = { submission: 'NOT_SUBMITTED', error: err instanceof Error ? err.message : String(err) };
    }

    let recorded = true;
    try {
      await recordAudit(this.prisma as any, {
        actorAddress,
        action: 'order.attestFiatPaid',
        targetType: 'Order',
        targetId: order.id,
        before: auditPayload({ status: order.status, contractId, tradeId: order.tradeId }),
        after: auditPayload({ evidence, ...outcome }),
      });
    } catch (err) {
      recorded = false;
      this.log.error(
        `order.attestFiatPaid could not be recorded for order ${order.id} — submission=${outcome.submission} tx=${outcome.txHash ?? 'none'} trade=${order.tradeId} contract=${contractId} actor=${actorAddress} evidence=${JSON.stringify(evidence)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (outcome.submission === 'NOT_SUBMITTED') {
      if (refusal instanceof HttpException) {
        throw refusal;
      }
      throw new InternalServerErrorException(
        recorded
          ? `this attestation was not submitted, and the attempt is recorded: ${outcome.error}`
          : `this attestation was not submitted, and the attempt could not be recorded either: ${outcome.error}`,
      );
    }
    if (outcome.submission !== 'SUCCESS') {
      throw new BadGatewayException(
        `the chain refused this attestation (${outcome.submission}, tx ${outcome.txHash}) — the deposit is still FUNDED`,
      );
    }

    const moved = await this.prisma.order.updateMany({
      where: { id: order.id, status: 'FUNDED' },
      data: { status: 'FIAT_PAID' },
    });
    if (moved.count > 0) {
      try {
        await this.notifications.notifyOrderStatus(order, 'FIAT_PAID');
      } catch (err) {
        this.log.error(`order ${order.id} attested and moved to FIAT_PAID, but the provider was not told: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      this.log.warn(`order ${order.id} was attested on chain (${outcome.txHash}) but its row had already left FUNDED`);
    }

    return { orderId: order.id, submission: outcome.submission, txHash: outcome.txHash };
  }
}
