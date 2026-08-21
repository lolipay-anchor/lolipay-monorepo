import { Global, Module } from '@nestjs/common';
import { UserReputationService } from './user-reputation.service';

@Global()
@Module({
  providers: [UserReputationService],
  exports: [UserReputationService],
})
export class ReputationModule {}
