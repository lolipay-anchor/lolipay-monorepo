import { AppConfigService } from '../config/app-config.service';

export interface JwtVerifyOptions {
  secret: string;
  algorithms: ['HS256'];
  issuer: string;
  audience: string;
}

function requireUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `JWT_ISSUER must be an absolute URI — SEP-10 tokens carry it as \`iss\`, and the ` +
        `acceptance suite validates that claim against the "uri" format. Got: ${value}`,
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`JWT_ISSUER must be an http(s) URI. Got: ${value}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('JWT_ISSUER must not carry a credential — it is published in every token');
  }
  return parsed.href;
}

export function jwtVerifyOptions(cfg: AppConfigService): JwtVerifyOptions {
  return {
    secret: cfg.jwtSecret,
    algorithms: ['HS256'],
    issuer: requireUri(cfg.jwtIssuer),
    audience: cfg.jwtAudience,
  };
}

export function jwtSignOptions(cfg: AppConfigService): {
  expiresIn: number;
  issuer: string;
  audience: string;
} {
  return { expiresIn: cfg.jwtTtl, issuer: requireUri(cfg.jwtIssuer), audience: cfg.jwtAudience };
}
