import { readFileSync } from 'fs';
import { join } from 'path';

describe('prisma.config.ts', () => {
  const source = readFileSync(join(__dirname, '../../prisma.config.ts'), 'utf8');

  it('does not resolve the connection string eagerly, so prisma generate runs without a database', () => {
    expect(source).not.toMatch(/\benv\(['"]DATABASE_URL['"]\)/);
  });

  it('still takes the connection string from the environment', () => {
    expect(source).toContain('process.env.DATABASE_URL');
  });
});
