import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PersonModule } from '../person/person.module';
import { KycModule } from '../kyc/kyc.module';
import { RateModule } from '../rate/rate.module';
import { OrderModule } from '../order/order.module';
import { Sep24Controller } from './sep24.controller';
import { Sep24Service } from './sep24.service';

@Module({
  imports: [PrismaModule, PersonModule, KycModule, RateModule, OrderModule],
  controllers: [Sep24Controller],
  providers: [Sep24Service],
})
export class Sep24Module {}
