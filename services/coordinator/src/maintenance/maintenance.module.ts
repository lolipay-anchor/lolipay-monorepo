import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { MaintenanceService } from './maintenance.service';

@Module({
  imports: [PrismaModule, NotificationModule],
  providers: [MaintenanceService],
})
export class MaintenanceModule {}
