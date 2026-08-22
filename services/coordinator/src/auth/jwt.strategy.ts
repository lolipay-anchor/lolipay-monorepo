import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRole, isTokenClass } from './role.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private cfg: AppConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: cfg.jwtSecret,

      algorithms: ['HS256'],
    });
  }

  async validate(payload: { sub: string; cls?: unknown }) {
    if (!isTokenClass(payload.cls)) {
      throw new UnauthorizedException('token class missing or unrecognised');
    }
    const role = await resolveRole(payload.sub, this.prisma, this.cfg.adminAddresses, payload.cls);
    return { address: payload.sub, role, cls: payload.cls };
  }
}
