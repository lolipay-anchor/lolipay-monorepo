import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type Role = 'admin' | 'lp' | 'user';

export type TokenClass = 'session' | 'sep10';

export const TOKEN_CLASSES: readonly TokenClass[] = ['session', 'sep10'];
export const MAY_PROMOTE: readonly TokenClass[] = ['session'];
export const MAY_OPEN_SOCKET: readonly TokenClass[] = ['session'];

export function isTokenClass(value: unknown): value is TokenClass {
  return typeof value === 'string' && (TOKEN_CLASSES as readonly string[]).includes(value);
}

export async function resolveRole(
  address: string,
  prisma: PrismaService,
  adminAddresses: string[],
  cls: TokenClass,
): Promise<Role> {
  const link = await prisma.walletLink.findUnique({ where: { stellarAddress: address } });
  if (!link || link.status !== 'ACTIVE') {
    throw new UnauthorizedException('address is not a proven wallet');
  }

  if (!MAY_PROMOTE.includes(cls)) return 'user';
  if (adminAddresses.includes(address)) return 'admin';
  const lp = await prisma.lp.findUnique({ where: { stellarAddress: address } });
  if (lp?.status === 'APPROVED') return 'lp';
  return 'user';
}
