import helmet from 'helmet';

export function cspAllowingRpc(rpcUrl: string): string {
  const defaults = helmet.contentSecurityPolicy.getDefaultDirectives() as Record<string, unknown>;
  let origin: string;
  try {
    origin = new URL(rpcUrl).origin;
  } catch {
    origin = '';
  }
  const directives: Record<string, unknown> = {
    ...defaults,
    'connect-src': origin ? ["'self'", origin] : ["'self'"],
  };
  return Object.entries(directives)
    .map(([name, value]) => {
      if (value === true || (Array.isArray(value) && value.length === 0)) return name;
      const parts = Array.isArray(value) ? value : [String(value)];
      return `${name} ${parts.join(' ')}`;
    })
    .join(';');
}
