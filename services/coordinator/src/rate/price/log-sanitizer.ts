const NON_PRINTABLE_ASCII = /[^\x20-\x7e]+/g;

export function sanitizeForLog(value: string, maxLen = 200): string {
  return value.replace(NON_PRINTABLE_ASCII, ' ').slice(0, maxLen);
}
