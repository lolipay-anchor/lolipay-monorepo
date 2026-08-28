import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';
import { StubKycProvider } from '../kyc/stub-kyc-provider';

const complete = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

describe('nothing but a trusted delivery can say a screening happened', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('leaves a registered customer unscreened, however complete their submission', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send(complete)
      .expect(202);

    const row = await prisma.kycVerification.findUnique({
      where: { customerRef: kp.publicKey() },
    });
    expect(row).not.toBeNull();
    expect(row!.screenedAt).toBeNull();
    expect(row!.deliveredAt).toBeNull();
    expect(row!.environment).toBeNull();
  });

  it('offers no way for a provider to claim a screening it did not perform', async () => {
    const decision = await new StubKycProvider().start('GABC', complete);
    expect(Object.keys(decision)).not.toContain('screened');
  });

  it('no longer offers an environment variable that could turn pretending on', async () => {
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const template = readFileSync(path.resolve(__dirname, '../../.env.example'), 'utf8');
    expect(template).not.toMatch(/KYC_STUB_SCREENS/);
    expect(template).toMatch(/^DIDIT_ENVIRONMENT=live$/m);
  });
});
