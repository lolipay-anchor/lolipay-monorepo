import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { Market, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

interface SeedMarket {
  code: string;
  country: string;
  currencySymbol: string;
  locale: string;
  railName: string;
  priceMinPerUsdc: string;
  priceMaxPerUsdc: string;
  decimals: number;
  enabled: boolean;
}

export const SEED_MARKETS: SeedMarket[] = [
  {
    code: 'IDR',
    country: 'Indonesia',
    currencySymbol: 'Rp',
    locale: 'id-ID',
    railName: 'QRIS',
    priceMinPerUsdc: '5000',
    priceMaxPerUsdc: '50000',
    decimals: 0,
    enabled: true,
  },
  {
    code: 'PHP',
    country: 'Philippines',
    currencySymbol: '₱',
    locale: 'en-PH',
    railName: 'InstaPay',
    priceMinPerUsdc: '30',
    priceMaxPerUsdc: '120',
    decimals: 2,
    enabled: false,
  },
  {
    code: 'VND',
    country: 'Vietnam',
    currencySymbol: '₫',
    locale: 'vi-VN',
    railName: 'VietQR',
    priceMinPerUsdc: '15000',
    priceMaxPerUsdc: '40000',
    decimals: 0,
    enabled: false,
  },
  {
    code: 'INR',
    country: 'India',
    currencySymbol: '₹',
    locale: 'en-IN',
    railName: 'UPI',
    priceMinPerUsdc: '50',
    priceMaxPerUsdc: '150',
    decimals: 2,
    enabled: false,
  },
  {
    code: 'THB',
    country: 'Thailand',
    currencySymbol: '฿',
    locale: 'th-TH',
    railName: 'PromptPay',
    priceMinPerUsdc: '20',
    priceMaxPerUsdc: '60',
    decimals: 2,
    enabled: false,
  },
  {
    code: 'BRL',
    country: 'Brazil',
    currencySymbol: 'R$',
    locale: 'pt-BR',
    railName: 'PIX',
    priceMinPerUsdc: '3',
    priceMaxPerUsdc: '12',
    decimals: 2,
    enabled: false,
  },
];

@Injectable()
export class MarketsService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.seed();
  }

  async seed(): Promise<void> {
    for (const row of SEED_MARKETS) {
      await this.prisma.market.upsert({
        where: { code: row.code },
        update: {},
        create: row,
      });
    }
    this.invalidateCache();
  }

  async list(): Promise<Market[]> {
    return this.cached();
  }

  async get(code: string): Promise<Market | null> {
    const rows = await this.cached();
    return rows.find((m) => m.code === code) ?? null;
  }

  async getEnabled(code: string): Promise<Market> {
    const m = await this.get(code);
    if (!m) throw new BadRequestException(`unknown market: ${code}`);
    if (!m.enabled) throw new BadRequestException(`market not enabled: ${code}`);
    return m;
  }

  async update(code: string, patch: Prisma.MarketUncheckedUpdateInput): Promise<Market> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.market.findUnique({ where: { code } });
      if (!current) throw new BadRequestException(`unknown market: ${code}`);

      const nextEnabled = patch.enabled ?? current.enabled;
      const nextDecimals = patch.decimals ?? current.decimals;
      if (nextEnabled === true && (nextDecimals as number) > 0) {
        throw new BadRequestException(
          `cannot enable market ${code}: decimals=${nextDecimals} not supported yet (money path is whole-units only)`,
        );
      }

      const nextMin = (patch.priceMinPerUsdc ?? current.priceMinPerUsdc) as string;
      const nextMax = (patch.priceMaxPerUsdc ?? current.priceMaxPerUsdc) as string;
      const minNum = Number(nextMin);
      const maxNum = Number(nextMax);
      if (!(minNum > 0)) {
        throw new BadRequestException(`priceMinPerUsdc must be > 0 (got ${nextMin})`);
      }
      if (!(minNum < maxNum)) {
        throw new BadRequestException(
          `priceMinPerUsdc (${nextMin}) must be less than priceMaxPerUsdc (${nextMax})`,
        );
      }
      if (maxNum / minNum > 10) {
        throw new BadRequestException(
          `priceMaxPerUsdc/priceMinPerUsdc ratio too wide (${nextMax}/${nextMin} = ${(maxNum / minNum).toFixed(2)} > 10): degenerate bounds would neuter plausibility checks`,
        );
      }

      return tx.market.update({ where: { code }, data: patch });
    });
    this.invalidateCache();
    return updated;
  }

  private marketCache: { rows: Market[]; at: number } | null = null;
  private async cached(): Promise<Market[]> {
    const now = Date.now();
    if (this.marketCache && now - this.marketCache.at < MARKET_TTL_MS) {
      return this.marketCache.rows;
    }
    const rows = await this.prisma.market.findMany();
    this.marketCache = { rows, at: now };
    return rows;
  }

  private invalidateCache(): void {
    this.marketCache = null;
  }
}

const MARKET_TTL_MS = 5000;
