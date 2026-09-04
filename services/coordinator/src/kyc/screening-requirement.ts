export function acceptedForFunds(requireAml: boolean): { status: 'ACCEPTED'; screenedAt?: { not: null } } {
  return requireAml ? { status: 'ACCEPTED', screenedAt: { not: null } } : { status: 'ACCEPTED' };
}
