import { BadRequestException } from '@nestjs/common';

const FIAT_CODE_RE = /^[A-Z]{3}$/;

export function normalizeFiat(s: string): string {
  const upper = (s ?? '').trim().toUpperCase();
  if (!FIAT_CODE_RE.test(upper)) {
    throw new BadRequestException(`invalid fiat code: "${s}"`);
  }
  return upper;
}
