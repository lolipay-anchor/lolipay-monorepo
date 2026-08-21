import { randomInt } from 'crypto';

export const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRef(): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  }
  return `LP-${suffix}`;
}
