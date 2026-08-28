import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { baseUnitsToUsdc } from '../money/money';
import { serializeSep24, Sep24Record, Sep24TransactionJson } from './sep24-transaction';

const ORDER_FIELDS = {
  status: true,
  usdcAmount: true,
  fiatAmount: true,
  fiatCurrency: true,
  platformFeeBps: true,
  lpFeeBps: true,
  settlementTxHash: true,
  settledAt: true,
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
        },
      },
      withdraw: { [code]: { enabled: false } },
      fee: { enabled: false },
    };
  }

  private async screened(personId: string): Promise<boolean> {
    const row = await this.prisma.kycVerification.findFirst({
      where: { personId, status: 'ACCEPTED', screenedAt: { not: null } },
      select: { customerRef: true },
    });
    return row !== null;
  }

  private async dress(rows: any[]): Promise<Sep24TransactionJson[]> {
    const out: Sep24TransactionJson[] = [];
    for (const row of rows) {
      const record: Sep24Record = {
        id: row.id,
        stellarAccount: row.stellarAccount,
        startedAt: row.startedAt,
        kycVerified: await this.screened(row.personId),
        order: row.order ?? null,
      };
      out.push(serializeSep24(record, this.assets()));
    }
    return out;
  }

  async list(
    subject: string,
    query: { asset_code?: string; limit?: string; no_older_than?: string; kind?: string },
  ) {
    this.assertAssetServed(query.asset_code);
    if (query.kind !== undefined && query.kind !== 'deposit') return { transactions: [] };

    const since = query.no_older_than ? new Date(query.no_older_than) : undefined;
    if (since && Number.isNaN(since.getTime())) {
      throw new BadRequestException('no_older_than is not a readable time');
    }
    const take = query.limit ? Number(query.limit) : undefined;
    if (take !== undefined && (!Number.isFinite(take) || take < 1)) {
      throw new BadRequestException('limit is not a positive number');
    }

    const rows = await this.prisma.sep24Transaction.findMany({
      where: {
        stellarAccount: subject,
        ...(since ? { startedAt: { gte: since } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      ...(take !== undefined ? { take } : {}),
      include: { order: { select: ORDER_FIELDS } },
    });
    return { transactions: await this.dress(rows) };
  }

  async one(subject: string, query: { id?: string; stellar_transaction_id?: string; external_transaction_id?: string }) {
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
