export function acceptedForFunds(requireAml: boolean) {
  return requireAml
    ? { status: 'ACCEPTED' as const, screenedAt: { not: null } }
    : { status: 'ACCEPTED' as const, OR: [{ deliveredAt: { not: null } }, { screenedAt: { not: null } }] };
}

export function awaitingProvider(row: { status: string; screenedAt: Date | null; deliveredAt: Date | null }, requireAml: boolean): boolean {
  if (row.status !== 'ACCEPTED') return false;
  return requireAml ? row.screenedAt === null : row.deliveredAt === null && row.screenedAt === null;
}
