import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { ProviderReceiptController } from './provider-receipt.controller';
import { AuthModule } from '../auth/auth.module';
import { ConsumedChallengeService } from '../auth/consumed-challenge.service';
import { MarketModule } from '../market/market.module';
import { ReputationModule } from '../reputation/reputation.module';

@Module({
  imports: [AuthModule, MarketModule, ReputationModule, NotificationModule],
  providers: [AdminService, ConsumedChallengeService],
  controllers: [AdminController, ProviderReceiptController],
  exports: [AdminService],
})
export class AdminModule {}
