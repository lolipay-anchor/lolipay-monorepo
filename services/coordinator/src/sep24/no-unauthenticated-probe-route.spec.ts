import { PATH_METADATA } from '@nestjs/common/constants';
import { Sep24Controller } from './sep24.controller';

function declaredPaths(): string[] {
  const proto = Sep24Controller.prototype as any;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]))
    .flatMap((p) => (Array.isArray(p) ? p : [p]))
    .filter((p): p is string => typeof p === 'string');
}

describe('the sep24 controller declares no probe-shaped route, and no new top-level one unnoticed', () => {
  it('declares at least one route, so an empty reflection cannot pass this suite by accident', () => {
    expect(declaredPaths().length).toBeGreaterThan(5);
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
