import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { Sep12Controller } from './sep12.controller';
import { Sep12Service } from './sep12.service';
import { KYC_PROVIDER } from './kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';

@Module({
  imports: [PrismaModule],
  controllers: [Sep12Controller],
  providers: [Sep12Service, { provide: KYC_PROVIDER, useClass: StubKycProvider }],
  exports: [Sep12Service],
})
export class KycModule {}
