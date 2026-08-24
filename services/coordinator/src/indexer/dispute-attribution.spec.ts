import { attributeDisputer } from './indexer.service';

const USER = 'GUSER';
const LP = 'GLP';

describe('the chain decides who complained, not the request that claimed it', () => {
  it('names the user when the user signed', () => {
    expect(attributeDisputer(USER, USER, LP)).toBe('user');
  });

  it('names the provider when the provider signed', () => {
    expect(attributeDisputer(LP, USER, LP)).toBe('lp');
  });

  it('names neither when somebody else signed, so a party is never blamed', () => {
    expect(attributeDisputer('GRESOLVER', USER, LP)).toBe('resolver');
  });

  it('names neither when the order has no provider yet', () => {
    expect(attributeDisputer('GRESOLVER', USER, null)).toBe('resolver');
  });

  it('does not mistake a null provider for a match', () => {
    expect(attributeDisputer(USER, USER, null)).toBe('user');
  });
});
