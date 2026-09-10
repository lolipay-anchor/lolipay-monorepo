export const EMAIL_MAX_LENGTH = 254;

const HAS_BOTH_SIDES = /^.+@.+$/;
const HAS_SPACE_OR_CONTROL = /[\s\p{Cc}]/u;

export function isStorableEmailAddress(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v.length > EMAIL_MAX_LENGTH) return false;
  if (HAS_SPACE_OR_CONTROL.test(v)) return false;
  return HAS_BOTH_SIDES.test(v);
}
