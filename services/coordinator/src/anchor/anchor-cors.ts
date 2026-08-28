import cors from 'cors';
export interface AnchorCorsOptions {
  origin: string | string[] | false;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
}

const ANCHOR_PATHS = ['/auth'];
const ANCHOR_PREFIXES = ['/sep24/'];

export function isAnchorPath(path: string): boolean {
  const lowered = path.toLowerCase();
  const normalised = lowered.length > 1 && lowered.endsWith('/') ? lowered.slice(0, -1) : lowered;
  if (ANCHOR_PATHS.includes(normalised)) return true;
  return ANCHOR_PREFIXES.some((prefix) => `${normalised}/`.startsWith(prefix));
}

export function anchorCorsOptions(path: string, allowlist: string[]): AnchorCorsOptions {
  if (isAnchorPath(path)) {
    return {
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    };
  }
  return {
    origin: allowlist.length > 0 ? allowlist : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}

export function applyCors(app: { use: (handler: unknown) => void }, allowlist: string[]): void {
  app.use(
    cors((req, done) =>
      done(null, anchorCorsOptions((req as unknown as { path: string }).path, allowlist)),
    ),
  );
}
