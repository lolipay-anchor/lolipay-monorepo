import { Module } from '@nestjs/common';
import { OrderService } from './order.service';
import { OrderController, LpAssignmentsController } from './order.controller';
import { MatchingModule } from '../matching/matching.module';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';

import { RateModule } from '../rate/rate.module';
import { NotificationModule } from '../notification/notification.module';
import { ReputationModule } from '../reputation/reputation.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    MatchingModule,
    AuthModule,
    MarketModule,
    RateModule,
    NotificationModule,
    ReputationModule,
    RealtimeModule,
  ],
  providers: [OrderService],
  controllers: [OrderController, LpAssignmentsController],
  exports: [OrderService],
})
export class OrderModule {}
