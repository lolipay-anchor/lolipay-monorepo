import { Module } from '@nestjs/common';
import { MarketsService } from './markets.service';
import { MarketsPublicController } from './markets-public.controller';

@Module({
  controllers: [MarketsPublicController],
  providers: [MarketsService],
  exports: [MarketsService],
})
export class MarketModule {}
