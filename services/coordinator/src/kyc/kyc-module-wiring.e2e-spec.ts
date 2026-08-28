import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AccountSignersService } from '../sep10/account-signers.service';
import { KYC_PROVIDER } from './kyc-provider';
import { DiditKycProvider } from './didit-kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

async function bootWith(env: Record<string, string>): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ThrottlerStorage)
    .useValue(noopStorage)
    .overrideProvider(AccountSignersService)
    .useValue({ load: jest.fn().mockResolvedValue(null) })
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

describe('the application resolves the provider its configuration names', () => {
  const saved: Record<string, string | undefined> = {};
  const set = (env: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(env)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('resolves the vendor when a key and a workflow are configured', async () => {
    set({ DIDIT_API_KEY: 'example-key-not-a-real-one', DIDIT_WORKFLOW_ID: 'wf-1' });
    const app = await bootWith({});
    expect(app.get(KYC_PROVIDER)).toBeInstanceOf(DiditKycProvider);
    await app.close();
  });

  it('resolves the stub when nothing is configured', async () => {
    set({ DIDIT_API_KEY: undefined, DIDIT_WORKFLOW_ID: undefined });
    const app = await bootWith({});
    expect(app.get(KYC_PROVIDER)).toBeInstanceOf(StubKycProvider);
    await app.close();
  });

  it('refuses to start at all when a required setting is empty', async () => {
    set({ USDC_ASSET_ISSUER: '' });
    await expect(bootWith({})).rejects.toThrow(/refusing to start/);
  });
});
