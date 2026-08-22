import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRole, isTokenClass } from './role.util';
import { jwtVerifyOptions } from './jwt-options';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private cfg: AppConfigService,
    private prisma: PrismaService,
  ) {
    const opts = jwtVerifyOptions(cfg);
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: opts.secret,
      algorithms: opts.algorithms,
      issuer: opts.issuer,
      audience: opts.audience,
    });
  }

  async validate(payload: { sub?: unknown; cls?: unknown }) {
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new UnauthorizedException('token subject missing');
    }
    if (!isTokenClass(payload.cls)) {
      throw new UnauthorizedException('token class missing or unrecognised');
    }
    const role = await resolveRole(payload.sub, this.prisma, this.cfg.adminAddresses, payload.cls);
    return { address: payload.sub, role, cls: payload.cls };
  }
}
