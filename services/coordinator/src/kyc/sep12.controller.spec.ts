import { Sep12Controller } from './sep12.controller';

describe('the endpoint that spends money carries a limit of its own', () => {
  it('PUT /customer is throttled far tighter than the global bucket, because each call can buy a session', () => {
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', Sep12Controller.prototype.put);
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', Sep12Controller.prototype.put);
    expect(ttl).toBe(3_600_000);
    expect(limit).toBe(40);
  });
});
