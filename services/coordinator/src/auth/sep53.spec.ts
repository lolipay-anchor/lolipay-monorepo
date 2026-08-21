import { verifySep53 } from './sep53';

const ADDR = 'GBXFXNDLV4LSWA4VB7YIL5GBD7BVNR22SGBTDKMO2SBZZHDXSKZYCP7L';
const MSG = 'Hello, World!';
const SIG = 'fO5dbYhXUhBMhe6kId/cuVq/AfEnHRHEvsP8vXh03M1uLpi5e46yO2Q8rEBzu3feXQewcQE5GArp88u6ePK6BA==';

const SIG_URL = SIG.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SIG_HEX = Buffer.from(SIG, 'base64').toString('hex');

describe('verifySep53', () => {
  it('accepts the canonical test vector (standard base64)', () => {
    expect(verifySep53(ADDR, MSG, SIG)).toBe(true);
  });
  it('rejects a tampered message', () => {
    expect(verifySep53(ADDR, 'Goodbye', SIG)).toBe(false);
  });
  it('accepts the same signature in base64url encoding', () => {
    expect(verifySep53(ADDR, MSG, SIG_URL)).toBe(true);
  });
  it('accepts the same signature in hex encoding', () => {
    expect(verifySep53(ADDR, MSG, SIG_HEX)).toBe(true);
    expect(verifySep53(ADDR, MSG, '0x' + SIG_HEX)).toBe(true);
  });
  it('rejects a signature that does not decode to 64 bytes', () => {
    expect(verifySep53(ADDR, MSG, 'AAAA')).toBe(false);
    expect(verifySep53(ADDR, MSG, Buffer.alloc(32).toString('base64'))).toBe(false);
  });
  it('rejects non-base64/hex garbage without throwing', () => {
    expect(verifySep53(ADDR, MSG, 'not a signature!!')).toBe(false);
    expect(verifySep53(ADDR, MSG, '')).toBe(false);
  });
});
