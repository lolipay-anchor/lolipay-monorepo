import { UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AppConfigService } from '../config/app-config.service';

export const SEP24_INTERACTIVE_AUDIENCE = 'lolipay-sep24-interactive';
export const SEP24_INTERACTIVE_TTL_SECS = 1800;
export const SEP24_INTERACTIVE_LINK_TTL_SECS = 300;
export const SEP24_INTERACTIVE_ABSOLUTE_TTL_SECS = 86_400;

export type InteractiveTokenUse = 'link' | 'session';

export function mintInteractiveToken(
  cfg: AppConfigService,
  transactionId: string,
  account: string,
  ttlSecs: number = SEP24_INTERACTIVE_TTL_SECS,
  use: InteractiveTokenUse = 'session',
  abs: number = Math.floor(Date.now() / 1000) + SEP24_INTERACTIVE_ABSOLUTE_TTL_SECS,
): string {
  return jwt.sign({ acct: account, use, abs }, cfg.jwtSecret, {
    algorithm: 'HS256',
    subject: transactionId,
    issuer: cfg.jwtIssuer,
    audience: SEP24_INTERACTIVE_AUDIENCE,
    expiresIn: ttlSecs,
  });
}

export function readInteractiveToken(
  cfg: AppConfigService,
  token: string,
  transactionId: string,
  expected: InteractiveTokenUse = 'session',
): { account: string; abs: number } {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, cfg.jwtSecret, {
      algorithms: ['HS256'],
      issuer: cfg.jwtIssuer,
      audience: SEP24_INTERACTIVE_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw new UnauthorizedException('this link is not one this anchor issued, or it has expired');
  }
  if (payload.sub !== transactionId) {
    throw new UnauthorizedException('this link belongs to a different transaction');
  }
  if (payload.use !== expected) {
    throw new UnauthorizedException('this credential cannot be used that way');
  }
  const account = payload.acct;
  if (typeof account !== 'string' || account.length === 0) {
    throw new UnauthorizedException('this link names no account');
  }
  const abs = typeof payload.abs === 'number' ? payload.abs : 0;
  if (abs > 0 && abs <= Math.floor(Date.now() / 1000)) {
    throw new UnauthorizedException('this session has been open too long — start again from your wallet');
  }
  return { account, abs };
}
