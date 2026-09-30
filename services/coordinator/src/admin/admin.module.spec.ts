import { MODULE_METADATA } from '@nestjs/common/constants';
import { AdminModule } from './admin.module';
import { ProviderReceiptController } from './provider-receipt.controller';

describe('AdminModule', () => {
  it('lists the provider receipt controller among its controllers', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AdminModule)).toContain(ProviderReceiptController);
  });
});
