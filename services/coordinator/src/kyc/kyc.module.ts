import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigService } from '../config/app-config.service';
import { PersonModule } from '../person/person.module';
import { Sep12Controller } from './sep12.controller';
import { DiditWebhookController } from './didit-webhook.controller';
import { Sep12Service } from './sep12.service';
import { KYC_PROVIDER } from './kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';

@Module({
  imports: [PrismaModule, PersonModule],
  controllers: [Sep12Controller, DiditWebhookController],
  providers: [Sep12Service, {
      provide: KYC_PROVIDER,
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => new StubKycProvider(cfg.kycStubScreens),
    }],
  exports: [Sep12Service],
})
export class KycModule {}
