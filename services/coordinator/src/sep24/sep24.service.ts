import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { StrKey } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { baseUnitsToUsdc } from '../money/money';
import { serializeSep24, Sep24Record, Sep24TransactionJson } from './sep24-transaction';
import {
  SEP24_PAGE_DEFAULT,
  SEP24_PAGE_MAX,
  TransactionsQueryDto,
  TransactionQueryDto,
} from './sep24-query.dto';

const ORDER_FIELDS = {
  status: true,
  usdcAmount: true,
  fiatAmount: true,
  fiatCurrency: true,
  platformFeeBps: true,
  lpFeeBps: true,
  settlementTxHash: true,
  settledAt: true,
  personId: true,
  ref: true,
} as const;

@Injectable()
export class Sep24Service {
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
  ) {}

  private assets() {
    return { baseUrl: this.cfg.anchorBaseUrl, usdcIssuer: this.cfg.usdcAssetIssuer };
  }

  private assertAssetServed(assetCode: string | undefined): void {
    if (assetCode !== undefined && assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
  }

  async info() {
    const config = await this.prisma.config.findFirst();
    const code = this.cfg.usdcAssetCode;
    return {
      deposit: {
        [code]: {
          enabled: true,
          min_amount: baseUnitsToUsdc(config?.minOrder ?? 0n),
          max_amount: baseUnitsToUsdc(config?.maxOrder ?? 0n),
          fee_percent: ((config?.platformFeeBps ?? 0) + (config?.lpFeeBps ?? 0)) / 100,
        },
      },
      withdraw: { [code]: { enabled: false } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
    };
  }

  private async screenedPeople(personIds: string[]): Promise<Set<string>> {
    if (personIds.length === 0) return new Set();
    const rows = await this.prisma.kycVerification.findMany({
      where: { personId: { in: personIds }, status: 'ACCEPTED', screenedAt: { not: null } },
      select: { personId: true },
    });
    return new Set(rows.map((r) => r.personId));
  }

  private async dress(rows: any[]): Promise<Sep24TransactionJson[]> {
    const screened = await this.screenedPeople([...new Set(rows.map((r) => r.personId))]);
    return rows.map((row) =>
      serializeSep24(
        {
          id: row.id,
          stellarAccount: row.stellarAccount,
          startedAt: row.startedAt,
          kycVerified: screened.has(row.personId),
          order: row.order && row.order.personId === row.personId ? row.order : null,
        } as Sep24Record,
        this.assets(),
      ),
    );
  }

  async list(
    subject: string,
    query: TransactionsQueryDto,
  ) {
    this.assertAssetServed(query.asset_code);
    if (query.kind && query.kind !== 'deposit') return { transactions: [] };

    const since = query.no_older_than ? new Date(query.no_older_than) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      throw new BadRequestException('no_older_than is not a readable time');
    }
    const take = Math.min(query.limit ?? SEP24_PAGE_DEFAULT, SEP24_PAGE_MAX);

    const rows = await this.prisma.sep24Transaction.findMany({
      where: {
        stellarAccount: subject,
        ...(since ? { startedAt: { gte: since } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take,
      include: { order: { select: ORDER_FIELDS } },
    });
    return { transactions: await this.dress(rows) };
  }

  async one(subject: string, query: TransactionQueryDto) {
    const where = query.id
      ? { id: query.id }
      : query.stellar_transaction_id
        ? { order: { settlementTxHash: query.stellar_transaction_id } }
        : query.external_transaction_id
          ? { order: { ref: query.external_transaction_id } }
          : null;
    if (!where) throw new BadRequestException('name a transaction by id, stellar_transaction_id or external_transaction_id');

    const row = await this.prisma.sep24Transaction.findFirst({
      where: { ...where, stellarAccount: subject },
      include: { order: { select: ORDER_FIELDS } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction for you');
    const [transaction] = await this.dress([row]);
    return { transaction };
  }

  async openInteractive(subject: string, personId: string, body: Record<string, unknown>) {
    const assetCode = body.asset_code;
    if (typeof assetCode !== 'string' || assetCode.length === 0) {
      throw new BadRequestException('asset_code is required');
    }
    if (assetCode !== this.cfg.usdcAssetCode) {
      throw new BadRequestException(`this anchor does not serve ${assetCode}`);
    }
    if (body.account !== undefined) {
      if (typeof body.account !== 'string' || body.account.length > 96) {
        throw new BadRequestException('account is not a Stellar address');
      }
      const named = body.account.split(':')[0];
      const known =
        StrKey.isValidEd25519PublicKey(named) ||
        StrKey.isValidMed25519PublicKey(named) ||
        StrKey.isValidContract(named);
      if (!known) {
        throw new BadRequestException('account is not a Stellar address');
      }
      if (body.account !== subject && named !== subject.split(':')[0]) {
        throw new BadRequestException(
          'this anchor credits the account its token speaks for, and will not deposit to another',
        );
      }
    }

    const row = await this.prisma.sep24Transaction.create({
      data: { personId, stellarAccount: subject, assetCode },
    });
    return {
      type: 'interactive_customer_info_needed',
      url: `${this.cfg.anchorBaseUrl}/sep24/interactive/${row.id}`,
      id: row.id,
    };
  }

  async moreInfo(id: string): Promise<string> {
    const row = await this.prisma.sep24Transaction.findUnique({
      where: { id },
      include: { order: { select: ORDER_FIELDS } },
    });
    if (!row) throw new NotFoundException('this anchor holds no such transaction');
    const [tx] = await this.dress([row]);
    return [
      '<!doctype html><html lang="en"><head><meta charset="utf-8">',
      '<title>lolipay deposit</title></head><body>',
      '<h1>lolipay deposit</h1>',
      `<p>Status: <strong>${tx.status}</strong></p>`,
      `<p>Started: ${tx.started_at}</p>`,
      '</body></html>',
    ].join('');
  }
}
