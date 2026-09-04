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

  it('answers a memo-bearing token that asks by its base account, because the memo names a session and not an account', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp, 4242);

    await request(app.getHttpServer())
      .get(`/customer?account=${kp.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/customer?account=${kp.publicKey()}&memo=4242`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
  });

  it('still refuses a memo that is not the one the token speaks for', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp, 4242);

    await request(app.getHttpServer())
      .get(`/customer?account=${kp.publicKey()}&memo=9999`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(404);
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


  async function personFor(address: string): Promise<string> {
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: address } });
    if (link) return link.personId;
    const person = await prisma.person.create({ data: {} });
    await prisma.walletLink.create({
      data: { stellarAddress: address, personId: person.id, authMethod: 'SEP10' },
    });
    return person.id;
  }

  it('finds the customer from the token alone, with neither id nor account', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: await personFor(kp.publicKey()),
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
    });

    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    expect(res.body.status).toBe('ACCEPTED');
    expect(res.body.id).toBe(kp.publicKey());
  });

  it('never calls a customer accepted while the screening it requires has not happened', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: await personFor(kp.publicKey()),
        status: 'ACCEPTED',
        verifiedAt: new Date(),
        screenedAt: null,
      },
    });

    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    expect(res.body.status).toBe('PROCESSING');
    expect(res.body.status).not.toBe('ACCEPTED');
    expect(String(res.body.message)).toMatch(/screening/i);
  });

  it('keeps two memos on one account apart', async () => {
    const kp = Keypair.random();
    const withMemo = await anchorToken(app, kp, 4242);
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: await personFor(kp.publicKey()),
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
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
      data: {
        customerRef: kp.publicKey(),
        personId: await personFor(kp.publicKey()),
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
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

  it('does not answer for a customer the caller did not register', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const stranger = Keypair.random().publicKey();
    await prisma.kycVerification.create({
      data: {
        customerRef: stranger,
        personId: await personFor(stranger),
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
    });

    for (const q of [`id=${stranger}`, `account=${stranger}`]) {
      const res = await request(app.getHttpServer())
        .get(`/customer?${q}`)
        .set('Authorization', `Bearer ${jwt}`);
      expect(res.status).toBe(404);
    }
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

  it('answers a refusal recorded against another subject of the same person, because a refusal belongs to the person and not to the memo it arrived under', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const personId = await personFor(kp.publicKey());
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), personId, status: 'NEEDS_INFO' },
    });
    await prisma.kycVerification.create({
      data: { customerRef: `${kp.publicKey()}:4242`, personId, status: 'REJECTED', rejectionReason: 'sanctions or watchlist match' },
    });

    const res = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    expect(res.body.status).toBe('REJECTED');
    expect(res.body.message).toBe('sanctions or watchlist match');
    expect(res.body.fields).toBeUndefined();
  });
});
