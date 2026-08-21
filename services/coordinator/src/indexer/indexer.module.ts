import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { ReputationModule } from '../reputation/reputation.module';
import { IndexerService } from './indexer.service';

@Module({
  imports: [PrismaModule, NotificationModule, ReputationModule],
  providers: [IndexerService],
})
export class IndexerModule {}
