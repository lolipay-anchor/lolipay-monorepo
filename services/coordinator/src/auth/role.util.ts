import { PrismaService } from '../prisma/prisma.service';

export type Role = 'admin' | 'lp' | 'user';

export async function resolveRole(
  address: string,
  prisma: PrismaService,
  adminAddresses: string[],
): Promise<Role> {
  if (adminAddresses.includes(address)) return 'admin';
  const lp = await prisma.lp.findUnique({ where: { stellarAddress: address } });
  if (lp?.status === 'APPROVED') return 'lp';
  return 'user';
}
