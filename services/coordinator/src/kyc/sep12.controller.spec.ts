import { Sep12Controller } from './sep12.controller';
import { Sep24Controller } from '../sep24/sep24.controller';

const limitOf = (handler: object) => Reflect.getMetadata('THROTTLER:LIMITdefault', handler);
const ttlOf = (handler: object) => Reflect.getMetadata('THROTTLER:TTLdefault', handler);

describe('the endpoints that spend money carry a limit of their own', () => {
  it('PUT /customer is throttled far tighter than the global bucket, because each call can buy a session', () => {
    expect(ttlOf(Sep12Controller.prototype.put)).toBe(3_600_000);
    expect(limitOf(Sep12Controller.prototype.put)).toBe(40);
  });

  it('the interactive identity step reaches the same provider call, so it carries the same limit and the same window', () => {
    expect(limitOf(Sep24Controller.prototype.identity)).toBe(limitOf(Sep12Controller.prototype.put));
    expect(ttlOf(Sep24Controller.prototype.identity)).toBe(ttlOf(Sep12Controller.prototype.put));
  });
});
