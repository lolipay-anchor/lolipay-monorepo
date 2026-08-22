import * as fs from 'fs';
import * as path from 'path';
import { STATUS_MAP } from './stellar-read.service';

const TYPES_RS = path.resolve(__dirname, '../../../../contracts/escrow/src/types.rs');

function readRustStatusVariants(): { name: string; discriminant: number }[] {
  const src = fs.readFileSync(TYPES_RS, 'utf8');
  const block = src.match(/pub enum Status \{([^}]*)\}/);
  if (!block) throw new Error(`could not find "pub enum Status" in ${TYPES_RS}`);

  return block[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .map((l) => {
      const m = l.match(/^([A-Za-z]\w*)\s*=\s*(\d+)\s*,?$/);
      if (!m) throw new Error(`unparsable Status variant: ${l}`);
      return { name: m[1], discriminant: Number(m[2]) };
    });
}

function screamingSnake(pascal: string): string {
  return pascal.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

describe('STATUS_MAP is decoded positionally against the escrow contract (INV-14.9)', () => {
  const variants = readRustStatusVariants();

  it('finds the contract source it is asserting against', () => {
    expect(fs.existsSync(TYPES_RS)).toBe(true);
    expect(variants.length).toBeGreaterThan(0);
  });

  it('has exactly one entry per Rust variant', () => {
    expect(STATUS_MAP).toHaveLength(variants.length);
  });

  it('places every variant at the index its discriminant names', () => {
    for (const { name, discriminant } of variants) {
      expect(STATUS_MAP[discriminant]).toBe(screamingSnake(name));
    }
  });

  it('uses contiguous discriminants starting at zero, because the map is an array', () => {
    const seen = variants.map((v) => v.discriminant).sort((a, b) => a - b);
    expect(seen).toEqual(variants.map((_, i) => i));
  });

  it('pins the current mapping, so an inserted variant fails here and not in production', () => {
    expect(STATUS_MAP).toEqual(['FUNDED', 'FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED']);
  });
});
