import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { Sep24Controller } from './sep24.controller';
import { Sep24Service } from './sep24.service';

@Module({
  imports: [PrismaModule],
  controllers: [Sep24Controller],
  providers: [Sep24Service],
})
export class Sep24Module {}
