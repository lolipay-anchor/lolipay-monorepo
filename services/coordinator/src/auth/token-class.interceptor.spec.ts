import { CallHandler, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ALLOW_TOKEN_CLASSES, TokenClassInterceptor } from './token-class.interceptor';
import { TOKEN_CLASSES } from './role.util';

function ctxFor(user: any, allowed?: readonly string[], type = 'http'): ExecutionContext {
  const handler = () => undefined;
  const cls = class {};
  if (allowed) Reflect.defineMetadata(ALLOW_TOKEN_CLASSES, allowed, handler);
  return {
    getType: () => type,
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as any;
}

const next: CallHandler = { handle: () => of('reached the handler') };

function run(user: any, allowed?: readonly string[], type?: string) {
  return new TokenClassInterceptor(new Reflector()).intercept(
    ctxFor(user, allowed, type),
    next,
  );
}

describe('the internal API is closed to anchor tokens unless a route opts in', () => {
  it('lets an ordinary session through a route that says nothing', async () => {
    await expect(run({ address: 'GUSER', cls: 'session' }).toPromise()).resolves.toBe(
      'reached the handler',
    );
  });

  it('refuses a sep10 token on a route that says nothing', () => {
    expect(() => run({ address: 'GUSER', cls: 'sep10' })).toThrow(ForbiddenException);
  });

  it('lets a sep10 token through a route that opts in', async () => {
    await expect(
      run({ address: 'GUSER', cls: 'sep10' }, ['sep10']).toPromise(),
    ).resolves.toBe('reached the handler');
  });

  it('leaves an unauthenticated request to the authentication guard', async () => {
    await expect(run(undefined).toPromise()).resolves.toBe('reached the handler');
  });

  it('refuses a user object carrying no class at all', () => {
    expect(() => run({ address: 'GUSER' })).toThrow(ForbiddenException);
  });

  it('stays out of the way of non-http transports', async () => {
    await expect(run({ cls: 'sep10' }, undefined, 'ws').toPromise()).resolves.toBe(
      'reached the handler',
    );
  });

  it.each(TOKEN_CLASSES.filter((c) => c !== 'session'))(
    'refuses %s by default, so a class added later gains nothing',
    (cls) => {
      expect(() => run({ address: 'GUSER', cls })).toThrow(ForbiddenException);
    },
  );
});
