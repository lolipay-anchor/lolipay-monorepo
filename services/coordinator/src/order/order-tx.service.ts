import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { signingCutoffSecs } from '../config/contract-limits';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import { ConfigCache } from '../config/config-cache';
import { OrderStatusService } from './order-status.service';
import { mapRoles, Flow, getFiatPayer, requireLp } from './order.params';
import { describeContractError, describeStakingError } from './contract-error';
import { canDispute } from './dispute.util';

const CLOCK_SKEW_MARGIN_SECS = 900n;

@Injectable()
export class OrderTxService {
  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private cfg: AppConfigService,
    private status: OrderStatusService,
  ) {}

  async buildMarkFiatPaidTx(
    orderId: string,
    callerAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');

    const lp = requireLp(order);
    const fiatPayer = getFiatPayer(order.flow as Flow, order.userAddress, lp.stellarAddress);
    if (callerAddress !== fiatPayer) {
      throw new ForbiddenException('only the fiat payer may build this transaction');
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);

    if (currentOrder.status !== 'FUNDED') {
      throw new ConflictException('order must be in FUNDED status to mark fiat paid');
    }

    if (order.flow !== 'TOP_UP') {
      const config = await this.config();
      if (config.requireProof && !currentOrder.proofUrl) {
        throw new BadRequestException('payment proof required before marking paid');
      }
    }

    try {
      return await this.stellar.buildMarkFiatPaidTx(
        this.status.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildMarkFiatPaidTx error:', err instanceof Error ? err.message : String(err));
      const contractProblem = describeContractError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
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

    const lp = requireLp(order);
    const flow = order.flow as Flow;
    const roles = mapRoles(flow, order.userAddress, lp.stellarAddress);

    if (callerAddress !== roles.usdcProvider) {
      throw new ForbiddenException('only the usdc_provider may build this transaction');
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);

    const preChainCreateStatuses = ['MATCHED', 'AWAITING_ONCHAIN'];
    if (!preChainCreateStatuses.includes(currentOrder.status)) {
      throw new ConflictException(
        `order must be in ${preChainCreateStatuses.join(' or ')} status to build create_trade`,
      );
    }
    if (signingCutoffSecs(Number(currentOrder.payDeadline)) * 1000 <= Date.now()) {
      throw new ConflictException('the signing window for this order has closed; it will expire on its own');
    }

    try {
      return await this.stellar.buildCreateTradeTx({
        contractId: this.status.contractIdFor(currentOrder),
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
      const contractProblem = describeContractError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
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

    const lp = requireLp(order);
    const flow = order.flow as Flow;
    const roles = mapRoles(flow, order.userAddress, lp.stellarAddress);

    if (callerAddress !== roles.confirmer) {
      throw new ForbiddenException('only the confirmer may build this transaction');
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);

    if (currentOrder.status !== 'FIAT_PAID') {
      throw new ConflictException('order must be in FIAT_PAID status to confirm release');
    }

    try {
      return await this.stellar.buildConfirmReleaseTx(
        this.status.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildConfirmReleaseTx error:', err instanceof Error ? err.message : String(err));
      const contractProblem = describeContractError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
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
    if (!isParty) {
      const resolver = await this.stellar
        .readEscrowResolver(this.status.contractIdFor(order))
        .catch(() => null);
      if (resolver === null || callerAddress !== resolver) {
        throw new ForbiddenException(
          'only a trade party or the escrow resolver may raise a dispute',
        );
      }
    }

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);
    const config = await this.config();
    if (!canDispute(currentOrder, config)) {
      throw new ConflictException(
        'a dispute can only be raised while FIAT_PAID or within the post-settlement dispute window',
      );
    }
    try {
      return await this.stellar.buildRaiseDisputeTx(
        this.status.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
      );
    } catch (err) {
      console.error('buildRaiseDisputeTx error:', err instanceof Error ? err.message : String(err));
      const contractProblem = describeContractError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
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

    const currentOrder = await this.status.refreshOrderStatus(orderId, order);
    if (currentOrder.status !== 'DISPUTED') {
      throw new ConflictException('order is not in DISPUTED status');
    }
    try {
      return await this.stellar.buildResolveTx(
        this.status.contractIdFor(currentOrder),
        callerAddress,
        currentOrder.tradeId,
        outcome,
      );
    } catch (err) {
      console.error('buildResolveTx error:', err instanceof Error ? err.message : String(err));
      const contractProblem = describeContractError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildSlashTx(
    orderId: string,
    callerAddress: string,
    amount: bigint,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { lp: true },
    });
    if (!order) throw new NotFoundException('order not found');
    const lp = requireLp(order);

    if (amount <= 0n) {
      throw new BadRequestException('amount must be positive');
    }

    const current = await this.status.refreshOrderStatus(orderId, order);
    const flow = current.flow as Flow;

    if (current.status === 'RELEASED' || current.status === 'REFUNDED') {
      const providerDefaulted = flow === 'TOP_UP' && current.status === 'REFUNDED';
      const recipientDefaulted = flow === 'WITHDRAW' && current.status === 'RELEASED';
      if (!providerDefaulted && !recipientDefaulted) {
        throw new ConflictException(
          'this settlement left the user holding the money, not the provider — there is no provider bond to draw on',
        );
      }
    } else if (current.status !== 'DISPUTED') {
      throw new ConflictException(
        'a slash is restitution after settlement — this order has not settled, and while it has not, releasing or refunding the escrow is the remedy',
      );
    }

    let chain;
    try {
      chain = await this.stellar.getTradeStatusStrict(
        this.status.contractIdFor(current),
        current.tradeId,
      );
    } catch (err) {
      console.error('buildSlashTx chain read:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException(
        'cannot read the verdict on chain right now — refusing rather than sending you to sign something that will be rejected',
      );
    }
    if (!chain) {
      throw new ConflictException('the escrow has no record of this trade');
    }
    if (typeof chain.liabilityEstablished !== 'boolean') {
      throw new ServiceUnavailableException(
        'the deployed escrow did not report whether liability was established — refusing rather than guessing at a verdict',
      );
    }
    if (!chain.liabilityEstablished) {
      throw new ConflictException(
        'no liability has been established on this trade — resolving a dispute against the party holding the money is what establishes it, and the contract will refuse a slash until then',
      );
    }
    const deadline = chain.slashDeadline ?? 0n;
    if (deadline === 0n) {
      throw new ConflictException(
        'the slash window on this trade has been closed by an exonerating verdict',
      );
    }
    if (BigInt(Math.floor(Date.now() / 1000)) > deadline + CLOCK_SKEW_MARGIN_SECS) {
      throw new ConflictException(
        'the window to slash this trade closed some time ago — the bond is no longer reachable for it',
      );
    }

    const { recovered, remaining } = await this.slashState(current);
    if (remaining <= 0n) {
      throw new ConflictException(
        'this trade has already been recovered in full — nothing is left to take',
      );
    }
    if (amount > remaining) {
      throw new BadRequestException(
        `amount exceeds what is left on this trade — ${recovered} of ${order.usdcAmount} base units has already been recovered, leaving ${remaining}`,
      );
    }

    try {
      return await this.stellar.buildSlashTx(
        callerAddress,
        lp.stellarAddress,
        current.tradeId,
        amount,
      );
    } catch (err) {
      console.error('buildSlashTx error:', err instanceof Error ? err.message : String(err));
      const contractProblem = describeStakingError(err);
      if (contractProblem) {
        throw new ConflictException(contractProblem);
      }
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async orderForSlashState(
    orderId: string,
  ): Promise<{ tradeId: string; usdcAmount: bigint; contractId: string | null }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('order not found');
    return {
      tradeId: order.tradeId,
      usdcAmount: order.usdcAmount,
      contractId: order.contractId,
    };
  }

  async slashState(order: {
    tradeId: string;
    usdcAmount: bigint;
    contractId?: string | null;
  }): Promise<{
    tradeAmount: bigint;
    recovered: bigint;
    remaining: bigint;
    deadline: number | null;
    liabilityEstablished: boolean | null;
  }> {
    let recovered: bigint;
    try {
      recovered = await this.stellar.getSlashedSoFar(order.tradeId);
    } catch (err) {
      console.error('slashState error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException(
        'cannot read how much has already been recovered on this trade — refusing rather than risking a double recovery',
      );
    }
    let deadline: number | null = null;
    let liabilityEstablished: boolean | null = null;
    try {
      const chain = await this.stellar.getTradeStatusStrict(
        order.contractId ?? this.cfg.escrowContractId,
        order.tradeId,
      );
      if (chain) {
        liabilityEstablished =
          typeof chain.liabilityEstablished === 'boolean' ? chain.liabilityEstablished : null;
        const d = chain.slashDeadline ?? 0n;
        deadline = d > 0n ? Number(d) : null;
      }
    } catch (err) {
      console.error('slashState chain read:', err instanceof Error ? err.message : String(err));
    }

    const remaining = order.usdcAmount - recovered;
    return {
      tradeAmount: order.usdcAmount,
      recovered,
      remaining: remaining > 0n ? remaining : 0n,
      deadline,
      liabilityEstablished,
    };
  }

  private configCache = new ConfigCache();
  private config() {
    return this.configCache.read(this.prisma, this.cfg.platformWallet);
  }
}
