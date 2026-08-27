import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AccountSignersService } from '../sep10/account-signers.service';

const PUBLIC = 'Public Global Stellar Network ; September 2015';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

async function bootWith(env: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .overrideProvider(AccountSignersService)
      .useValue({ load: jest.fn().mockResolvedValue(null) })
      .compile();
    const app = mod.createNestApplication();
    await app.init();
    await app.close();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('the mainnet interlock is wired into the application, not only into its own unit test', () => {
  it('refuses to start on the public network while the stub may pretend to screen', async () => {
    await expect(
      bootWith({ STELLAR_NETWORK_PASSPHRASE: PUBLIC, KYC_STUB_SCREENS: 'true' }),
    ).rejects.toThrow(/KYC_STUB_SCREENS/);
  });

  it('starts on the public network when nothing is pretending', async () => {
    await expect(
      bootWith({ STELLAR_NETWORK_PASSPHRASE: PUBLIC, KYC_STUB_SCREENS: 'false' }),
    ).resolves.toBeUndefined();
  });
});
