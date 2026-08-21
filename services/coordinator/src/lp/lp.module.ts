import { Module } from '@nestjs/common';
import { LpService } from './lp.service';
import { LpController } from './lp.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [LpService],
  controllers: [LpController],
  exports: [LpService],
})
export class LpModule {}
