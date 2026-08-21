import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveRole } from './role.util';

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

  async validate(payload: { sub: string }) {
    const role = await resolveRole(payload.sub, this.prisma, this.cfg.adminAddresses);
    return { address: payload.sub, role };
  }
}
