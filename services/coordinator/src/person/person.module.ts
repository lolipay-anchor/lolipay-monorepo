import { Module } from '@nestjs/common';
import { PersonService } from './person.service';

@Module({
  providers: [PersonService],
  exports: [PersonService],
})
export class PersonModule {}
