import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from '../config/app-config.service';
import { PriceAdapter } from './price/price.types';
import { PRICE_ADAPTER } from './price/price-adapter.token';
import { applySpreadToRate, quoteFiat, quoteUsdcForFiat } from '../money/money';
import { normalizeFiat } from './fiat';
import { MarketsService } from '../market/markets.service';
import { ConfigCache } from '../config/config-cache';
import { UserReputationService } from '../reputation/user-reputation.service';
import { Flow, Market } from '../generated/prisma/client';

export const QUOTE_TTL_MS = 300_000;

const NUMERIC_STRING_RE = /^\d+(\.\d+)?$/;

export function computeQuoteFields(
  usdc: bigint,
  idrPerUsdc: string,
  cfg: { spreadBps: number; platformFeeBps: number; lpFeeBps: number },
  flow: Flow = 'TOP_UP',
) {
  const sell = flow !== 'TOP_UP';
  return {
    fiatAmount: quoteFiat(usdc, idrPerUsdc, cfg.spreadBps, sell),
    rateSnapshot: idrPerUsdc,
    platformFeeBps: cfg.platformFeeBps,
    lpFeeBps: cfg.lpFeeBps,
  };
}

@Injectable()
export class RateService {
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    @Inject(PRICE_ADAPTER) private adapter: PriceAdapter,
    private markets: MarketsService,
    private userReputation: UserReputationService,
  ) {}

  async getReferencePrice(fiat: string): Promise<string> {
    const market = await this.markets.getEnabled(normalizeFiat(fiat));
    const code = market.code;

    if (market.manualRateOverride) {
      if (NUMERIC_STRING_RE.test(market.manualRateOverride)) {
        this.assertPlausible(market.manualRateOverride, market, 'manual override');
        return market.manualRateOverride;
      }

      console.error(
        `ignoring malformed manualRateOverride for ${code}: "${market.manualRateOverride}"`,
      );
    }

    const cache = await this.prisma.fiatPriceCache.findUnique({ where: { fiat: code } });
    const cacheFresh =
      cache &&
      (Date.now() - cache.fetchedAt.getTime()) / 1000 < this.cfg.priceStaleSecs;

    if (cacheFresh) {
      this.assertPlausible(cache.pricePerUsdc, market, 'cache');
      return cache.pricePerUsdc;
    }

    let price: string;
    try {
      price = await this.refreshPrice(code);
    } catch {
      throw new ServiceUnavailableException('price source unavailable');
    }

    this.assertPlausible(price, market, 'price source');

    if (cache) {
      const prev = parseFloat(cache.pricePerUsdc);
      const now = parseFloat(price);
      if (this.deviatesTooFar(prev, now) && !this.confirmsPendingPrice(code, now)) {
        this.pendingPrice.set(code, price);
        console.error(
          `price anomaly (${code}): ${cache.pricePerUsdc} -> ${price}; holding quotes until a second fetch agrees`,
        );
        throw new ServiceUnavailableException('price anomaly');
      }
    }
    this.pendingPrice.delete(code);

    await this.prisma.fiatPriceCache.upsert({
      where: { fiat: code },
      update: { source: this.adapter.name, pricePerUsdc: price, fetchedAt: new Date() },
      create: {
        fiat: code,
        source: this.adapter.name,
        pricePerUsdc: price,
        fetchedAt: new Date(),
      },
    });

    return price;
  }

  private inflightByFiat = new Map<string, Promise<string>>();
  private refreshPrice(fiat: string): Promise<string> {
    const inflight = this.inflightByFiat.get(fiat);
    if (inflight) return inflight;

    const p = this.adapter
      .fetchPrices([fiat])
      .then((prices) => {
        const price = prices[fiat];

        if (!price) throw new Error(`price source missing fiat ${fiat}`);
        return price;
      })
      .finally(() => {
        this.inflightByFiat.delete(fiat);
      });

    this.inflightByFiat.set(fiat, p);
    return p;
  }

  async getDisplayRate(fiat: string): Promise<string> {
    const conf = await this.config();
    if (conf.paused) throw new ServiceUnavailableException('paused');

    const mid = await this.getReferencePrice(fiat);

    return applySpreadToRate(mid, conf.spreadBps);
  }

  async createQuote(
    userAddress: string,
    flow: 'TOP_UP' | 'WITHDRAW',
    rail: 'BANK' | 'QRIS' | 'EWALLET',
    input: { usdcAmount?: bigint; fiatAmount?: bigint },
    fiat: string = 'IDR',
  ) {

    const hasUsdc = input.usdcAmount != null;
    const hasFiat = input.fiatAmount != null;
    if (hasUsdc === hasFiat) {
      throw new BadRequestException('provide exactly one of usdcAmount or fiatAmount');
    }

    const market = await this.markets.getEnabled(normalizeFiat(fiat));

    const conf = await this.config();
    if (conf.paused) throw new ServiceUnavailableException('paused');
    const price = await this.getReferencePrice(market.code);

    let usdcAmount: bigint;
    let fiatAmount: bigint;
    if (hasFiat) {
      const sell = flow !== 'TOP_UP';
      usdcAmount = quoteUsdcForFiat(input.fiatAmount as bigint, price, conf.spreadBps, sell);
      fiatAmount = input.fiatAmount as bigint;
    } else {
      usdcAmount = input.usdcAmount as bigint;
      fiatAmount = computeQuoteFields(usdcAmount, price, conf, flow as Flow).fiatAmount;
    }

    if (usdcAmount < conf.minOrder || usdcAmount > conf.maxOrder) {
      throw new BadRequestException('amount out of range');
    }

    const personId = await this.userReputation.personIdFor(userAddress);
    const { tier } = await this.userReputation.getReputation(personId);
    const limitBase = this.userReputation.dailyLimitBaseUnits(tier, conf);
    const used = await this.userReputation.used24hBaseUnits(personId);
    if (used + usdcAmount > limitBase) {
      throw new BadRequestException('daily limit exceeded');
    }

    return this.prisma.quote.create({
      data: {
        userAddress,
        flow: flow as Flow,
        rail: rail as any,
        usdcAmount,
        fiatAmount,
        fiatCurrency: market.code,
        rateSnapshot: price,
        platformFeeBps: conf.platformFeeBps,
        lpFeeBps: conf.lpFeeBps,

        expiresAt: new Date(Date.now() + QUOTE_TTL_MS),
      },
    });
  }

  private pendingPrice = new Map<string, string>();

  private deviatesTooFar(prev: number, next: number): boolean {
    return (Math.abs(next - prev) / prev) * 10_000 > this.cfg.priceDeviationMaxBps;
  }

  private confirmsPendingPrice(fiat: string, next: number): boolean {
    const pending = this.pendingPrice.get(fiat);
    if (pending === undefined) return false;
    return !this.deviatesTooFar(parseFloat(pending), next);
  }

  private assertPlausible(priceStr: string, market: Market, context: string): void {
    const v = parseFloat(priceStr);
    const min = Number(market.priceMinPerUsdc);
    const max = Number(market.priceMaxPerUsdc);
    if (!Number.isFinite(v) || v <= 0 || v < min || v > max) {
      console.error(`price out of plausible bounds (${context}, ${market.code}): ${priceStr}`);
      throw new ServiceUnavailableException(`price out of plausible bounds (${context})`);
    }
  }

  private configCache = new ConfigCache();
  private config() {
    return this.configCache.read(this.prisma, this.cfg.platformWallet);
  }
}

