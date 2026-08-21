import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { AuthModule } from '../auth/auth.module';
import { ReputationModule } from '../reputation/reputation.module';

@Module({
  imports: [AuthModule, ReputationModule],
  controllers: [ProfileController],
})
export class ProfileModule {}
