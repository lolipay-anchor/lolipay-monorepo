import { readFileSync } from 'fs';
import { join } from 'path';
import { schemaFromUrl } from './prisma.service';

describe('schemaFromUrl', () => {
  it('reads the schema the connection string asks for', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/db?schema=lolipay')).toBe('lolipay');
  });

  it('reads it when other parameters come first', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/db?sslmode=require&schema=tenant_a')).toBe('tenant_a');
  });

  it('stops at the next parameter', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/db?schema=tenant_a&pool_timeout=5')).toBe('tenant_a');
  });

  it('decodes an escaped schema name', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/db?schema=my%20schema')).toBe('my schema');
  });

  it('is undefined when the connection string does not name one', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/db')).toBeUndefined();
  });

  it('does not mistake a database named schema for the parameter', () => {
    expect(schemaFromUrl('postgresql://u:p@h:5432/schema')).toBeUndefined();
  });

  it('is handed to the adapter, which does not read it from the URL itself', () => {
    const source = readFileSync(join(__dirname, 'prisma.service.ts'), 'utf8');
    expect(source).toMatch(/new PrismaPg\(\s*\{ connectionString: url \},\s*\{ schema: schemaFromUrl\(url\) \}\s*\)/);
  });
});
