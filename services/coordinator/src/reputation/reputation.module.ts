import { Global, Module } from '@nestjs/common';
import { UserReputationService } from './user-reputation.service';
import { PersonModule } from '../person/person.module';

@Global()
@Module({
  imports: [PersonModule],
  providers: [UserReputationService],
  exports: [UserReputationService],
})
export class ReputationModule {}
