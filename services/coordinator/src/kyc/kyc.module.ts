import { Logger, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AppConfigService } from '../config/app-config.service';
import { PersonModule } from '../person/person.module';
import { Sep12Controller } from './sep12.controller';
import { DiditWebhookController } from './didit-webhook.controller';
import { Sep12Service } from './sep12.service';
import { KYC_PROVIDER } from './kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';
import { DiditKycProvider } from './didit-kyc-provider';

export function chooseKycProvider(cfg: AppConfigService) {
  if (cfg.diditApiKey && cfg.diditWorkflowId) {
    new Logger('Kyc').log(`identity verification runs through the provider, environment ${cfg.diditEnvironment}`);
    return new DiditKycProvider(cfg);
  }
  new Logger('Kyc').warn(
    'identity verification runs through the stub: no provider is configured, so no screening will ever happen',
  );
  return new StubKycProvider();
}

@Module({
  imports: [PrismaModule, PersonModule],
  controllers: [Sep12Controller, DiditWebhookController],
  providers: [Sep12Service, {
      provide: KYC_PROVIDER,
      inject: [AppConfigService],
      useFactory: (cfg: AppConfigService) => chooseKycProvider(cfg),
    }],
  exports: [Sep12Service],
})
export class KycModule {}
