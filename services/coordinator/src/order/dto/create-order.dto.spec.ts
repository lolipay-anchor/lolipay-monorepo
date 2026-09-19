import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateOrderDto } from './create-order.dto';

const VALID_QUOTE_ID = '11111111-1111-4111-8111-111111111111';

const problems = (overrides: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateOrderDto, { quoteId: VALID_QUOTE_ID, ...overrides })).flatMap(
    (e) => Object.values(e.constraints ?? {}),
  );

describe('CreateOrderDto defers userPaymentMethod emptiness to the service, not to class-validator defaults', () => {
  it('produces no constraint for an empty userPaymentMethod, so validatePaymentDestination composes the sentence instead of the framework', () => {
    expect(problems({ userPaymentMethod: '' })).toEqual([]);
  });

  it('still refuses a non-string userPaymentMethod', () => {
    expect(problems({ userPaymentMethod: 12345 })).not.toEqual([]);
  });

  it('still enforces the 500-character ceiling that matches validatePaymentDestination\'s own limit', () => {
    expect(problems({ userPaymentMethod: 'B'.repeat(501) })).not.toEqual([]);
  });

  it('accepts exactly 500 characters, the same boundary the service enforces', () => {
    expect(problems({ userPaymentMethod: 'B'.repeat(500) })).toEqual([]);
  });

  it('still refuses a malformed quoteId, so an empty problems array above is not a broken validator', () => {
    expect(problems({ quoteId: 'not-a-uuid', userPaymentMethod: '' })).not.toEqual([]);
  });
});
