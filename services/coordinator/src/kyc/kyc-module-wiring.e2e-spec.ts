import { Test } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AccountSignersService } from '../sep10/account-signers.service';
import { KYC_PROVIDER } from './kyc-provider';
import { DiditKycProvider } from './didit-kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

async function boot(): Promise<INestApplication> {
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
    set({
      DIDIT_API_KEY: 'example-key-not-a-real-one',
      DIDIT_WORKFLOW_ID: 'wf-1',
      DIDIT_WEBHOOK_SECRET: 'example-secret-not-a-real-one',
    });
    const app = await boot();
    try {
      expect(app.get(KYC_PROVIDER)).toBeInstanceOf(DiditKycProvider);
    } finally {
      await app.close();
    }
  });

  it('resolves the stub when nothing is configured', async () => {
    set({ DIDIT_API_KEY: undefined, DIDIT_WORKFLOW_ID: undefined });
    const app = await boot();
    expect(app.get(KYC_PROVIDER)).toBeInstanceOf(StubKycProvider);
    await app.close();
  });

  it('refuses to start at all when a required setting is empty', async () => {
    set({ USDC_ASSET_ISSUER: '' });
    await expect(boot()).rejects.toThrow(/refusing to start/);
  });

  it('refuses to start on the public network while pointed at a mocked environment', async () => {
    set({
      STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Network ; September 2015',
      DIDIT_API_KEY: 'example-key-not-a-real-one',
      DIDIT_WORKFLOW_ID: 'wf-1',
      DIDIT_WEBHOOK_SECRET: 'example-secret-not-a-real-one',
      DIDIT_ENVIRONMENT: 'sandbox',
    });
    await expect(boot()).rejects.toThrow(/DIDIT_ENVIRONMENT/);
  });

  it('refuses to start with a provider configured and no shared secret to trust it by', async () => {
    set({
      DIDIT_API_KEY: 'example-key-not-a-real-one',
      DIDIT_WORKFLOW_ID: 'wf-1',
      DIDIT_WEBHOOK_SECRET: '',
    });
    await expect(boot()).rejects.toThrow(/DIDIT_WEBHOOK_SECRET/);
  });
});

describe('the boot-time screening check is actually reached by the container', () => {
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

  it('runs onModuleInit on the provider the factory produced, or the check would be dead code', async () => {
    set({
      DIDIT_API_KEY: 'example-key-not-a-real-one',
      DIDIT_WORKFLOW_ID: 'wf-1',
      DIDIT_WEBHOOK_SECRET: 'example-secret-not-a-real-one',
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const app = await boot();
    try {
      expect(app.get(KYC_PROVIDER)).toBeInstanceOf(DiditKycProvider);
      expect(warn.mock.calls.flat().join(' ')).toMatch(/could not read which checks|CANNOT SCREEN/i);
    } finally {
      warn.mockRestore();
      await app.close();
    }
  }, 30_000);
});
