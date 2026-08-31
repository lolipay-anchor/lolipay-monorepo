import { Global, Module } from '@nestjs/common';
import { StellarReadService } from './stellar-read.service';
import { RefundSignerService } from './refund-signer.service';
import { AttestorService } from './attestor.service';

@Global()
@Module({
  providers: [StellarReadService, RefundSignerService, AttestorService],
  exports: [StellarReadService, RefundSignerService, AttestorService],
})
export class StellarModule {}
