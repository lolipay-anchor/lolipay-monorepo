import { Global, Module } from '@nestjs/common';
import { StellarReadService } from './stellar-read.service';
import { RefundSignerService } from './refund-signer.service';

@Global()
@Module({
  providers: [StellarReadService, RefundSignerService],
  exports: [StellarReadService, RefundSignerService],
})
export class StellarModule {}
