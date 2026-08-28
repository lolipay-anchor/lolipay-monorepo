import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, sessionToken, anchorToken } from './auth-test-helpers';

const OPENED_TO_ANCHOR_TOKENS = [
  '/customer',
  '/sep24/transactions',
  '/sep24/transaction',
  '/sep24/transactions/deposit/interactive',
];

const SAMPLE: Record<string, string> = {
  ':id': '00000000-0000-4000-8000-000000000000',
  ':account': 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
};

type Route = { method: string; path: string };

function routesOf(app: INestApplication): Route[] {
  const express: any = app.getHttpAdapter().getInstance();
  const stack = express.router?.stack ?? express._router?.stack;
  if (!stack) {
    throw new Error('the express router moved; this test cannot enumerate routes and must not pass');
  }
  const found: Route[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const path: string = layer.route.path;
    const methods = layer.route.methods
      ? Object.keys(layer.route.methods).filter((m) => layer.route.methods[m])
      : Object.keys(layer.route.stack?.[0]?.method ? { [layer.route.stack[0].method]: true } : {});
    for (const method of methods) found.push({ method: method.toUpperCase(), path });
  }
  return found;
}

function concrete(path: string): string {
  return path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? (SAMPLE[`:${seg.slice(1)}`] ?? SAMPLE[seg] ?? 'x') : seg))
    .join('/');
}

function opened(path: string): boolean {
  return OPENED_TO_ANCHOR_TOKENS.some((p) => path === p || path.startsWith(`${p}/`));
}

describe('an anchor token is refused everywhere a session token is admitted', () => {

  let app: INestApplication;
  let routes: Route[];
  let session: string;
  let anchor: string;

  beforeAll(async () => {
    app = await bootAuthApp();
    const kp = Keypair.random();
    session = await sessionToken(app, kp);
    anchor = await anchorToken(app, kp);
    routes = routesOf(app);
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  it('found the application routes rather than an empty list', () => {
    expect(routes.length).toBeGreaterThanOrEqual(50);
  });

  it('refuses the anchor token on every route the session token reaches', async () => {
    const admitted: Route[] = [];
    const refusedToBoth: Route[] = [];
    const leaked: string[] = [];

    for (const route of routes) {
      const url = concrete(route.path);
      const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch';
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(verb)) continue;

      const anonymous = await (request(app.getHttpServer()) as any)[verb](url);
      if (anonymous.status !== 401 && anonymous.status !== 403) continue;

      const withSession = await (request(app.getHttpServer()) as any)
        [verb](url)
        .set('Authorization', `Bearer ${session}`);
      const sessionAdmitted = withSession.status !== 401 && withSession.status !== 403;
      if (sessionAdmitted) admitted.push(route);
      else refusedToBoth.push(route);

      const withAnchor = await (request(app.getHttpServer()) as any)
        [verb](url)
        .set('Authorization', `Bearer ${anchor}`);
      const anchorRefused = withAnchor.status === 401 || withAnchor.status === 403;
      if (!anchorRefused && !opened(route.path)) {
        const note = sessionAdmitted ? '' : ' (a session token is refused here too)';
        leaked.push(`${route.method} ${route.path}${note} -> ${withAnchor.status}`);
      }
    }

    expect(leaked).toEqual([]);
    expect(admitted.length).toBeGreaterThanOrEqual(5);
    expect(admitted.length + refusedToBoth.length).toBeGreaterThanOrEqual(45);
    for (const named of ['/admin/config', '/orders', '/customer', '/lp/assignments', '/webhooks/didit']) {
      expect(routes.some((r) => r.path === named)).toBe(true);
    }
  }, 180_000);
});
