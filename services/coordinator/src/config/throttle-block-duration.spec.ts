import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import { ExecutionContext } from '@nestjs/common';
import { RATE_LIMIT_POLICY } from '../app.module';
import { Sep24Controller } from '../sep24/sep24.controller';
import { Sep12Controller } from '../kyc/sep12.controller';

const LONG_TTL_ROUTES: Array<[string, Function, string]> = [
  ['Sep24Controller.openDeposit', Sep24Controller, 'openDeposit'],
  ['Sep24Controller.openWithdraw', Sep24Controller, 'openWithdraw'],
  ['Sep24Controller.identity', Sep24Controller, 'identity'],
  ['Sep24Controller.amount', Sep24Controller, 'amount'],
  ['Sep24Controller.fundTx', Sep24Controller, 'fundTx'],
  ['Sep24Controller.releaseTx', Sep24Controller, 'releaseTx'],
  ['Sep12Controller.put', Sep12Controller, 'put'],
];

function stubStorage(): jest.Mocked<ThrottlerStorage> {
  return {
    increment: jest.fn().mockResolvedValue({
      totalHits: 1,
      timeToExpire: 60,
      isBlocked: false,
      timeToBlockExpire: 0,
    }),
  } as unknown as jest.Mocked<ThrottlerStorage>;
}

function contextFor(controller: Function, method: string): ExecutionContext {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  return {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ ip: '203.0.113.9', headers: {} }),
      getResponse: () => ({ header: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

describe('the seven routes carrying a 1-hour @Throttle ttl resolve a 1-minute blockDuration from the module policy, not their own ttl as a fallback', () => {
  it.each(LONG_TTL_ROUTES)('%s', async (_label, controller, method) => {
    const storage = stubStorage();
    const guard = new ThrottlerGuard(RATE_LIMIT_POLICY as any, storage, new Reflector());
    await (guard as any).onModuleInit();

    await guard.canActivate(contextFor(controller, method));

    expect(storage.increment).toHaveBeenCalledTimes(1);
    const args = storage.increment.mock.calls[0];
    const ttl = args[1];
    const blockDuration = args[3];

    expect(ttl).toBe(3_600_000);
    expect(blockDuration).toBe(60_000);
    expect(blockDuration).not.toBe(ttl);
  });
});
