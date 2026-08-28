import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { MonitoringService } from './monitoring.service';
import { AlertsService } from './alerts.service';
import { DiditRefusalsService } from './didit-refusals.service';
import { MonitoringController } from './monitoring.controller';

@Global()
@Module({
  imports: [PrismaModule, AuthModule],
  providers: [MonitoringService, AlertsService, DiditRefusalsService],
  controllers: [MonitoringController],
  exports: [AlertsService, DiditRefusalsService],
})
export class MonitoringModule {}
