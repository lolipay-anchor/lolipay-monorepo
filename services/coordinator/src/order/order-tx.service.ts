import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import { ConfigCache } from '../config/config-cache';
import { OrderStatusService } from './order-status.service';
import { mapRoles, Flow, getFiatPayer, requireLp } from './order.params';
import { describeContractError } from './contract-error';
import { canDispute } from './dispute.util';

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
    if (!isParty) throw new ForbiddenException('only a trade party may raise a dispute');

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

  private configCache = new ConfigCache();
  private config() {
    return this.configCache.read(this.prisma, this.cfg.platformWallet);
  }
}
