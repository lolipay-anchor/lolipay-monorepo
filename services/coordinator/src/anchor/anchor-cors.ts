export interface AnchorCorsOptions {
  origin: string | string[] | false;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
}

const ANCHOR_PATHS = ['/auth', '/.well-known/stellar.toml'];

export function isAnchorPath(path: string): boolean {
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ANCHOR_PATHS.includes(normalised);
}

export function anchorCorsOptions(path: string, allowlist: string[]): AnchorCorsOptions {
  if (isAnchorPath(path)) {
    return {
      origin: '*',
      credentials: false,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    };
  }
  return {
    origin: allowlist.length > 0 ? allowlist : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
}
