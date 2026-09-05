export const UNREADABLE_SCREENING = 'the screening could not be read';
export const SCREENING_DID_NOT_RUN = 'the screening did not run';
export const HIT_REFUSAL = 'sanctions or watchlist match';
export const SCREENING_REQUIRED_FAILED = 'the required screening could not be carried out';
export const UNREADABLE_DECLINE = 'the refusal carried no readable cause';

export function acceptedForFunds(requireAml: boolean) {
  return requireAml
    ? { status: 'ACCEPTED' as const, screenedAt: { not: null } }
    : { status: 'ACCEPTED' as const, deliveredAt: { not: null } };
}

export function awaitingProvider(
  row: { status: string; screenedAt: Date | null; deliveredAt: Date | null },
  requireAml: boolean,
): boolean {
  if (row.status !== 'ACCEPTED') return false;
  return requireAml ? row.screenedAt === null : row.deliveredAt === null;
}

export function deliveredButUnreadable() {
  return { status: 'NEEDS_INFO' as const, rejectionReason: UNREADABLE_SCREENING };
}

export function screeningDidNotRun() {
  return { status: 'NEEDS_INFO' as const, rejectionReason: SCREENING_DID_NOT_RUN };
}
