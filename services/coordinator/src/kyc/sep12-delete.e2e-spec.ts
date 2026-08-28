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

  it('forgets only the memo that asked, not its sibling on the same account', async () => {
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
    expect(sibling.body.status).not.toBe('NEEDS_INFO');
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
