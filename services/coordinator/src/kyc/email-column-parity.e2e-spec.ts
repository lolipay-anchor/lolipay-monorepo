import { INestApplication } from '@nestjs/common';
import { bootAuthApp } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';
import { isStorableEmailAddress } from './email-address';

describe('the guard in front of the email column never lets through what the column refuses', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('asks Postgres which code points its CHECK rejects, and refuses every one of them in TypeScript', async () => {
    const rows = await prisma.$queryRawUnsafe<{ cp: number }[]>(
      `select cp from generate_series(1, 65535) as cp
       where cp not between 55296 and 57343
         and chr(cp) ~ '[[:space:][:cntrl:]]'`,
    );
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.map((r) => Number(r.cp))).toContain(0x85);

    const admitted = rows
      .map((r) => Number(r.cp))
      .filter((cp) => isStorableEmailAddress('a@b' + String.fromCharCode(cp) + 'c'));

    expect(admitted).toEqual([]);
  });

  it('and the column really does refuse one of them, so the query above is measuring a live constraint', async () => {
    const person = await prisma.person.create({ data: {} });
    await expect(
      prisma.person.update({ where: { id: person.id }, data: { email: 'a@b' + String.fromCharCode(0x85) + 'c' } }),
    ).rejects.toThrow();
    await prisma.person.delete({ where: { id: person.id } });
  });

  it('accepts an ordinary address end to end, so the guard is not simply refusing everything', async () => {
    const person = await prisma.person.create({ data: {} });
    expect(isStorableEmailAddress('budi.santoso@example.com')).toBe(true);
    await prisma.person.update({ where: { id: person.id }, data: { email: 'budi.santoso@example.com' } });
    const back = await prisma.person.findUnique({ where: { id: person.id }, select: { email: true } });
    expect(back?.email).toBe('budi.santoso@example.com');
    await prisma.person.delete({ where: { id: person.id } });
  });
});
