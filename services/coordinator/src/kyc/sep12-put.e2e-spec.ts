import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';

const complete = {
  first_name: 'Budi',
  last_name: 'Santoso',
  email_address: 'budi@example.com',
  id_type: 'id_card',
  id_country_code: 'IDN',
};

describe('PUT /customer registers a customer without keeping what it was told', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('refuses a caller who presents no token', async () => {
    const res = await request(app.getHttpServer()).put('/customer').send(complete);
    expect([401, 403]).toContain(res.status);
  });

  it('answers 202 with a string id, which is what the suite requires and not all the spec allows', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    const res = await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send(complete)
      .expect(202);
    expect(typeof res.body.id).toBe('string');
  });

  it('gives two memos on one account two separate customers', async () => {
    const kp = Keypair.random();
    const a = await anchorToken(app, kp, 1001);
    const b = await anchorToken(app, kp, 1002);

    const first = await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${a}`)
      .send({ memo: '1001', memo_type: 'id', ...complete })
      .expect(202);
    const second = await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${b}`)
      .send({ memo: '1002', memo_type: 'id', ...complete })
      .expect(202);

    expect(first.body.id).not.toBe(second.body.id);
  });

  it('leaves NEEDS_INFO once every field the fixture carries is supplied', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send(complete)
      .expect(202);

    const got = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(got.body.status).not.toBe('NEEDS_INFO');
  });

  it('stays in NEEDS_INFO while a required field is missing', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ first_name: 'Budi' })
      .expect(202);

    const got = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(got.body.status).toBe('NEEDS_INFO');
  });

  it('describes what it holds without repeating a single value back', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send(complete)
      .expect(202);

    const got = await request(app.getHttpServer())
      .get('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);

    const provided = got.body.provided_fields ?? {};
    expect(Object.keys(provided)).toEqual(expect.arrayContaining(Object.keys(complete)));
    for (const f of Object.values(provided) as any[]) {
      expect(typeof f.type).toBe('string');
      expect(typeof f.description).toBe('string');
    }
    const body = JSON.stringify(got.body);
    for (const value of Object.values(complete)) expect(body).not.toContain(value);
  });

  it('never writes a customer field into any log channel', async () => {
    const spies = [
      ...(['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      ),
      ...(['log', 'warn', 'error'] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];

    const jwt = await anchorToken(app, Keypair.random());
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send(complete)
      .expect(202);

    const said = spies.flatMap((sp) => sp.mock.calls.flat()).map(String).join(' ');
    spies.forEach((sp) => sp.mockRestore());
    for (const value of Object.values(complete)) expect(said).not.toContain(value);
  });

  it('refuses a body field nobody named', async () => {
    const jwt = await anchorToken(app, Keypair.random());
    const res = await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ ...complete, callback: 'https://evil.example' });
    expect(res.status).toBe(400);
  });
});
