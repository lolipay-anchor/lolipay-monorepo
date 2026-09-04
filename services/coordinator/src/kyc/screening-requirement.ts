export function acceptedForFunds(requireAml: boolean): { status: 'ACCEPTED'; screenedAt?: { not: null }; deliveredAt?: { not: null } } {
  return requireAml ? { status: 'ACCEPTED', screenedAt: { not: null } } : { status: 'ACCEPTED', deliveredAt: { not: null } };
}

export function awaitingProvider(row: { status: string; screenedAt: Date | null; deliveredAt: Date | null }, requireAml: boolean): boolean {
  return row.status === 'ACCEPTED' && (requireAml ? row.screenedAt === null : row.deliveredAt === null);
}
