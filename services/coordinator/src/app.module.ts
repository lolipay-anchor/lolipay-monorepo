import { Module, Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppConfigModule } from './config/config.module';
import { StorageModule } from './storage/storage.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { IndexerModule } from './indexer/indexer.module';
import { NotificationModule } from './notification/notification.module';
import { MonitoringModule } from './monitoring/monitoring.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { StellarModule } from './stellar/stellar.module';
import { RateModule } from './rate/rate.module';
import { MarketModule } from './market/market.module';
import { LpModule } from './lp/lp.module';
import { AdminModule } from './admin/admin.module';
import { MatchingModule } from './matching/matching.module';
import { OrderModule } from './order/order.module';
import { ReputationModule } from './reputation/reputation.module';
import { ProfileModule } from './profile/profile.module';
import { RealtimeModule } from './realtime/realtime.module';

@Controller('health')
class HealthController {
  @Get() ok() { return { status: 'ok' }; }
}

@Module({
  imports: [

    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    ScheduleModule.forRoot(),
    MaintenanceModule,
    RealtimeModule,
    IndexerModule,
    NotificationModule,
    MonitoringModule,
    AppConfigModule,
    StorageModule,
    PrismaModule,
    ReputationModule,
    AuthModule,
    StellarModule,
    RateModule,
    MarketModule,
    LpModule,
    AdminModule,
    MatchingModule,
    OrderModule,
    ProfileModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
