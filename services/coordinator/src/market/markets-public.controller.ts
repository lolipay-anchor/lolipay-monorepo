import { Controller, Get } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MarketsService } from './markets.service';

@Controller('markets')
export class MarketsPublicController {
  constructor(private readonly markets: MarketsService) {}

  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Get()
  async list() {
    const rows = await this.markets.list();
    return rows.map((m) => ({
      code: m.code,
      country: m.country,
      currency_symbol: m.currencySymbol,
      locale: m.locale,
      rail_name: m.railName,
      enabled: m.enabled,
    }));
  }
}
