import { SEP24_INTERACTIVE_TTL_SECS } from './interactive-token';

export function sessionCookieName(transactionId: string): string {
  return `sep24_${transactionId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

export function sessionCookieOptions(transactionId: string) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: `/sep24/interactive/${transactionId}`,
    maxAge: SEP24_INTERACTIVE_TTL_SECS * 1000,
  };
}

export function readCookies(header: string | undefined, name: string): string[] {
  if (!header) return [];
  const found: string[] = [];
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    try {
      found.push(decodeURIComponent(part.slice(at + 1).trim()));
    } catch {
      continue;
    }
  }
  return found;
}

export function originIsForeign(origin: string | undefined, baseUrl: string): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin !== new URL(baseUrl).origin;
  } catch {
    return true;
  }
}
