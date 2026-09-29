import { Module } from '@nestjs/common';
import { CoinbaseAdapter } from './price/coinbase.adapter';
import { PRICE_ADAPTER } from './price/price-adapter.token';
import { RateService } from './rate.service';
import { RateController } from './rate.controller';
import { RatePublicController } from './rate-public.controller';
import { MarketModule } from '../market/market.module';
import { ReputationModule } from '../reputation/reputation.module';

export { PRICE_ADAPTER } from './price/price-adapter.token';

@Module({
  imports: [MarketModule, ReputationModule],
  providers: [
    CoinbaseAdapter,
    { provide: PRICE_ADAPTER, useClass: CoinbaseAdapter },
    RateService,
  ],
  controllers: [RateController, RatePublicController],
  exports: [RateService],
})
export class RateModule {}
