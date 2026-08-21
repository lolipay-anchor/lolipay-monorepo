import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { RateService } from './rate.service';
import { MarketsService } from '../market/markets.service';
import { normalizeFiat } from './fiat';

@Controller('rate')
export class RatePublicController {
  constructor(
    private readonly rate: RateService,
    private readonly markets: MarketsService,
  ) {}

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get()
  async getRate(@Query('fiat') fiat = 'IDR') {
    const code = normalizeFiat(fiat);

    const market = await this.markets.get(code);
    if (!market) throw new BadRequestException(`unsupported fiat: ${code}`);
    if (!market.enabled) throw new BadRequestException('fiat not enabled');

    const rate = await this.rate.getDisplayRate(code);

    return {
      asset: 'USDC',
      fiat: code,
      rate,
      ts: new Date().toISOString(),
    };
  }
}
