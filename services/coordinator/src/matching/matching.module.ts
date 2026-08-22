import { Module } from '@nestjs/common';
import { MatchingService } from './matching.service';
import { PersonModule } from '../person/person.module';

@Module({
  imports: [PersonModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
