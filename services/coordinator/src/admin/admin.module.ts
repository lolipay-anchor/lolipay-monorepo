import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AuthModule } from '../auth/auth.module';
import { MarketModule } from '../market/market.module';
import { ReputationModule } from '../reputation/reputation.module';

@Module({
  imports: [AuthModule, MarketModule, ReputationModule, NotificationModule],
  providers: [AdminService],
  controllers: [AdminController],
  exports: [AdminService],
})
export class AdminModule {}
