import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

const complete = {
  first_name: 'Siti',
  last_name: 'Rahayu',
  email_address: 'siti@example.com',
  id_type: 'passport',
  id_country_code: 'IDN',
};

describe('DELETE /customer forgets a customer without forgetting the wallet', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
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

  it('refuses a caller who presents no token', async () => {
    const res = await request(app.getHttpServer()).delete(`/customer/${Keypair.random().publicKey()}`);
    expect([401, 403]).toContain(res.status);
  });

  it('answers exactly 200 on the round trip the suite walks', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);

    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ account: kp.publicKey(), ...complete })
      .expect(202);
    await request(app.getHttpServer())
      .get(`/customer?account=${kp.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    const del = await request(app.getHttpServer())
      .delete(`/customer/${kp.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(del.status).toBe(200);

    const after = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(after.body.status).toBe('NEEDS_INFO');
    expect(after.body.id).toBeUndefined();
  });

  it('says so plainly when there was nothing to forget, rather than reporting a deletion it did not make', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const del = await request(app.getHttpServer())
      .delete(`/customer/${kp.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(del.status).toBe(404);
  });

  it('refuses to forget an account the token does not speak for', async () => {
    const mine = Keypair.random();
    const theirs = Keypair.random();
    const jwt = await anchorToken(app, mine);
    await prisma.kycVerification.create({
      data: {
        customerRef: theirs.publicKey(),
        personId: await personFor(theirs.publicKey()),
        status: 'ACCEPTED',
      },
    });

    const del = await request(app.getHttpServer())
      .delete(`/customer/${theirs.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(del.status).toBe(403);

    const survived = await prisma.kycVerification.findUnique({
      where: { customerRef: theirs.publicKey() },
    });
    expect(survived).not.toBeNull();
  });

  it('forgets the sibling memo too, because one wallet is one person and erasure is not per subject', async () => {
    const kp = Keypair.random();
    const one = await anchorToken(app, kp, 5001);
    const two = await anchorToken(app, kp, 5002);
    await request(app.getHttpServer())
      .put('/customer').set('Authorization', `Bearer ${one}`).send(complete).expect(202);
    await request(app.getHttpServer())
      .put('/customer').set('Authorization', `Bearer ${two}`).send(complete).expect(202);

    await request(app.getHttpServer())
      .delete(`/customer/${kp.publicKey()}`)
      .set('Authorization', `Bearer ${one}`)
      .expect(200);

    const sibling = await request(app.getHttpServer())
      .get('/customer').set('Authorization', `Bearer ${two}`).expect(200);
    expect(sibling.body.status).toBe('NEEDS_INFO');

    const held = await prisma.kycVerification.findMany({
      where: { customerRef: { startsWith: kp.publicKey() } },
    });
    expect(held).toHaveLength(0);
  });

  it('leaves the wallet link standing, because SEP-12 forgets identity data and not the proof of the wallet', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .put('/customer').set('Authorization', `Bearer ${jwt}`).send(complete).expect(202);
    await request(app.getHttpServer())
      .delete(`/customer/${kp.publicKey()}`).set('Authorization', `Bearer ${jwt}`).expect(200);

    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    expect(link?.status).toBe('ACTIVE');
  });
});

describe('erasure reaches every refusal a person carries, against the real database', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('redacts both refused wallets when a third asks to be forgotten, and lifts neither refusal', async () => {
    const asking = Keypair.random();
    const jwt = await anchorToken(app, asking);
    const link = await prisma.walletLink.findUnique({
      where: { stellarAddress: asking.publicKey() },
    });
    const personId = link!.personId;

    const refused: string[] = [];
    for (const n of [1, 2]) {
      const other = Keypair.random().publicKey();
      await prisma.walletLink.create({
        data: { stellarAddress: other, personId, authMethod: 'SEP10' },
      });
      await prisma.kycVerification.create({
        data: {
          customerRef: other,
          personId,
          status: 'REJECTED',
          rejectionReason: `sanctions or watchlist match ${n}`,
          screenedAt: new Date(),
          verifiedAt: new Date(),
        },
      });
      refused.push(other);
    }

    const res = await request(app.getHttpServer())
      .delete(`/customer/${asking.publicKey()}`)
      .set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);

    const rows = await prisma.kycVerification.findMany({
      where: { customerRef: { in: refused } },
      orderBy: { customerRef: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('REJECTED');
      expect(row.rejectionReason).toBeNull();
      expect(row.screenedAt).toBeNull();
      expect(row.verifiedAt).toBeNull();
      expect(row.personId).toBe(personId);
    }
  });

  it('erases the reason on a refused row of the same person even when it also has a row to delete, so one DELETE is enough', async () => {
    const kp = Keypair.random();
    const one = await anchorToken(app, kp, 7001);
    const two = await anchorToken(app, kp, 7002);
    await request(app.getHttpServer())
      .put('/customer').set('Authorization', `Bearer ${one}`).send({ first_name: 'Budi' }).expect(202);
    const personId = (await prisma.kycVerification.findUniqueOrThrow({ where: { customerRef: `${kp.publicKey()}:7001` } })).personId;
    await prisma.kycVerification.create({
      data: { customerRef: `${kp.publicKey()}:7002`, personId, status: 'REJECTED', rejectionReason: 'sanctions or watchlist match', deliveredAt: new Date() },
    });

    await request(app.getHttpServer())
      .delete(`/customer/${kp.publicKey()}`)
      .set('Authorization', `Bearer ${two}`)
      .expect(200);

    expect(await prisma.kycVerification.findUnique({ where: { customerRef: `${kp.publicKey()}:7001` } })).toBeNull();
    const refused = await prisma.kycVerification.findUniqueOrThrow({ where: { customerRef: `${kp.publicKey()}:7002` } });
    expect(refused.status).toBe('REJECTED');
    expect(refused.rejectionReason).toBeNull();
    expect(refused.deliveredAt).not.toBeNull();
  });
});
