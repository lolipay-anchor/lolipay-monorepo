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
