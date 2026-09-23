import { PATH_METADATA } from '@nestjs/common/constants';
import { MetadataScanner } from '@nestjs/core';
import { Sep24Controller } from './sep24.controller';

const proto = Sep24Controller.prototype as any;

function routeMethods(): string[] {
  return new MetadataScanner()
    .getAllMethodNames(proto)
    .filter((name) => Reflect.hasMetadata(PATH_METADATA, proto[name]));
}

function declaredPaths(): string[] {
  return routeMethods()
    .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]))
    .flatMap((p) => (Array.isArray(p) ? p.flat(Infinity) : [p]))
    .filter((p): p is string => typeof p === 'string');
}

describe('the sep24 controller declares no probe-shaped route, and no new top-level one unnoticed', () => {
  it('serves one prefix and reads a path for every route method, so nothing is dropped before the other tests look', () => {
    expect(Reflect.getMetadata(PATH_METADATA, Sep24Controller)).toBe('sep24');
    expect(routeMethods().length).toBeGreaterThan(5);
    expect(declaredPaths().length).toBeGreaterThanOrEqual(routeMethods().length);
  });

  it('declares no route whose path mentions a probe, in either the string or the array form', () => {
    expect(declaredPaths().filter((p) => /probe/i.test(p))).toEqual([]);
  });

  it('adds no top-level route without this list being updated, which forces the decision to be made', () => {
    const free = declaredPaths().filter((p) => !p.startsWith('interactive/') && !p.startsWith('more-info/'));
    expect(free.sort()).toEqual([
      'info',
      'transaction',
      'transactions',
      'transactions/deposit/interactive',
      'transactions/withdraw/interactive',
    ]);
  });
});

describe('every route in the sep24 controller carries its own throttle, never the global default', () => {
  it('has at least one route method to check, so an empty list cannot pass this block by vacuity', () => {
    expect(routeMethods().length).toBeGreaterThan(5);
  });

  it('names every route whose TTL or LIMIT is not an actual number, so a silent fall-through or an undefined value cannot hide', () => {
    const unthrottled = routeMethods().filter(
      (name) =>
        typeof Reflect.getMetadata('THROTTLER:TTLdefault', proto[name]) !== 'number' ||
        typeof Reflect.getMetadata('THROTTLER:LIMITdefault', proto[name]) !== 'number',
    );
    expect(unthrottled).toEqual([]);
  });

  it('exempts no individual route from throttling with a handler-level THROTTLER:SKIPdefault, which the rejected per-route workaround would need', () => {
    const skipped = routeMethods().filter((name) => Reflect.hasMetadata('THROTTLER:SKIPdefault', proto[name]));
    expect(skipped).toEqual([]);
  });

  it('exempts no route by way of a CLASS-LEVEL THROTTLER:SKIPdefault, which a handler-scoped check cannot see', () => {
    expect(Reflect.hasMetadata('THROTTLER:SKIPdefault', Sep24Controller)).toBe(false);
  });
});
