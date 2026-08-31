import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SEP24_INTERACTIVE_LINK_TTL_SECS, mintInteractiveToken } from './interactive-token';

describe('a link is bound to the account it was issued for, not only to the transaction', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function opened() {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, account: kp.publicKey() };
  }

  it('refuses a token naming the right transaction and the wrong account', async () => {
    const { id, account } = await opened();
    const stranger = Keypair.random().publicKey();
    expect(stranger).not.toBe(account);
    const forged = mintInteractiveToken(
      app.get(AppConfigService),
      id,
      stranger,
      SEP24_INTERACTIVE_LINK_TTL_SECS,
      'link',
    );
    await http().get(`/sep24/interactive/${id}?token=${forged}`).expect(404);
  });

  it('stops serving the deposit page once the wallet behind it is revoked', async () => {
    const { id, account } = await opened();
    const link = mintInteractiveToken(
      app.get(AppConfigService),
      id,
      account,
      SEP24_INTERACTIVE_LINK_TTL_SECS,
      'link',
    );
    const hop = await http().get(`/sep24/interactive/${id}?token=${link}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(200);

    await prisma.walletLink.update({
      where: { stellarAddress: account },
      data: { status: 'REVOKED' },
    });

    await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(404);
  });

  it('refuses a session credential presented as if it were the link, so a leaked link cannot be traded up', async () => {
    const { id, account } = await opened();
    const asSession = mintInteractiveToken(app.get(AppConfigService), id, account);
    await http().get(`/sep24/interactive/${id}?token=${asSession}`).expect(401);
  });

  it('admits the token naming the account the transaction belongs to', async () => {
    const { id, account } = await opened();
    const honest = mintInteractiveToken(
      app.get(AppConfigService),
      id,
      account,
      SEP24_INTERACTIVE_LINK_TTL_SECS,
      'link',
    );
    await http().get(`/sep24/interactive/${id}?token=${honest}`).expect(302);
  });
});
