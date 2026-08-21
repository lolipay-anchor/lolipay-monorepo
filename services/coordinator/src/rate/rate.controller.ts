import { Body, Controller, Post, UseGuards, Req } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { RateService } from './rate.service';
import { QuoteDto } from './dto/quote.dto';

@Controller('quotes')
@UseGuards(AuthGuard('jwt'))
export class RateController {
  constructor(private rate: RateService) {}

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post()
  async quote(@Req() req: any, @Body() dto: QuoteDto) {
    const q = await this.rate.createQuote(
      req.user.address,
      dto.flow,
      dto.rail,
      {
        usdcAmount: dto.usdcAmount != null ? BigInt(dto.usdcAmount) : undefined,
        fiatAmount: dto.fiatAmount != null ? BigInt(dto.fiatAmount) : undefined,
      },
      dto.fiat,
    );
    return {
      quote_id: q.id,
      usdc_amount: q.usdcAmount.toString(),
      fiat_amount: q.fiatAmount.toString(),
      fiat: q.fiatCurrency,
      rate: q.rateSnapshot,
      platform_fee_bps: q.platformFeeBps,
      lp_fee_bps: q.lpFeeBps,
      expires_at: q.expiresAt,
    };
  }
}
