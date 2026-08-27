import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken, sessionToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('GET /customer tells a caller where their verification stands', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a caller who presents no token', async () => {
    const res = await request(app.getHttpServer()).get('/customer');
    expect([401, 403]).toContain(res.status);
  });

  it('tells a customer it has never seen what it needs, and gives them no id', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    expect(res.body.status).toBe('NEEDS_INFO');
    expect(res.body.id).toBeUndefined();
    expect(Object.keys(res.body.fields)).toEqual(
      expect.arrayContaining([
        'first_name',
        'last_name',
        'email_address',
        'id_type',
        'id_country_code',
      ]),
    );
    for (const f of Object.values(res.body.fields) as any[]) {
      expect(['string', 'number', 'date', 'binary']).toContain(f.type);
      expect(typeof f.description).toBe('string');
    }
  });

  it('finds the customer from the token alone, with neither id nor account', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), status: 'ACCEPTED', screenedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.id).toBe(kp.publicKey());
  });

  it('keeps two memos on one account apart', async () => {
    const kp = Keypair.random();
    const withMemo = await anchorToken(app, kp, 4242);
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), status: 'ACCEPTED', screenedAt: new Date() },
    });

    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${withMemo}`)
      .expect(200);

    expect(res.body.status).toBe('NEEDS_INFO');
    expect(res.body.id).toBeUndefined();
  });

  it('serves a session token too, because the peer-to-peer door shares this record', async () => {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), status: 'ACCEPTED', screenedAt: new Date() },
    });
    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(res.body.id).toBe(kp.publicKey());
  });

  it('bounds what a stranger may put in the query string', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);

    const unknown = await request(app.getHttpServer())
      .get('/customer?callback=https://evil.example')
      .set('Authorization', `Bearer ${jwt}`);
    expect(unknown.status).toBe(400);

    const tooLong = await request(app.getHttpServer())
      .get(`/customer?id=${'x'.repeat(500)}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(tooLong.status).toBe(400);
  });

  it('accepts the query fields the acceptance suite actually sends', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    for (const q of [`account=${kp.publicKey()}`, `id=${kp.publicKey()}`, 'type=sep31-sender', 'lang=en']) {
      const res = await request(app.getHttpServer())
        .get(`/customer?${q}`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(res.status).toBe(200);
    }
  });
});
