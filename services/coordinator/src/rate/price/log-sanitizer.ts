const UNSAFE_LOG_CHARS = /[\x00-\x1f\x7f\u0085\u2028\u2029]+/g;

export function sanitizeForLog(value: string, maxLen = 200): string {
  return value.replace(UNSAFE_LOG_CHARS, ' ').slice(0, maxLen);
}
