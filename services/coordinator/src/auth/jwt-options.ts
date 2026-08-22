import { AppConfigService } from '../config/app-config.service';

export interface JwtVerifyOptions {
  secret: string;
  algorithms: ['HS256'];
  issuer: string;
  audience: string;
}

export function jwtVerifyOptions(cfg: AppConfigService): JwtVerifyOptions {
  return {
    secret: cfg.jwtSecret,
    algorithms: ['HS256'],
    issuer: cfg.jwtIssuer,
    audience: cfg.jwtAudience,
  };
}

export function jwtSignOptions(cfg: AppConfigService): {
  expiresIn: number;
  issuer: string;
  audience: string;
} {
  return { expiresIn: cfg.jwtTtl, issuer: cfg.jwtIssuer, audience: cfg.jwtAudience };
}
