import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { verifySep53 } from './sep53';
import { resolveRole } from './role.util';
import { jwtSignOptions } from './jwt-options';
import { AppConfigService } from '../config/app-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../person/person.service';

const PREFIX = 'lolipay-auth';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private jwt: JwtService,
    private cfg: AppConfigService,
    private prisma: PrismaService,
    private people: PersonService,
  ) {}

  private reject(address: string, reason: string): never {
    this.logger.warn(`verify FAILED addr=${address || '<none>'} reason=${reason}`);
    throw new UnauthorizedException(reason);
  }

  issueChallenge(address: string): string {
    const nonce = randomBytes(16).toString('hex');
    const exp = Date.now() + this.cfg.challengeTtl * 1000;
    const payload = `${PREFIX}:${address}:${nonce}:${exp}`;
    return `${payload}:${this.mac(payload)}`;
  }

  async verify(address: string, challenge: string, signature: string): Promise<string> {
    const parts = challenge.split(':');
    if (parts.length !== 5 || parts[0] !== PREFIX) {
      this.reject(address, 'malformed challenge');
    }
    const [tag, addr, nonce, expStr, mac] = parts;
    const payload = `${tag}:${addr}:${nonce}:${expStr}`;

    if (!this.macMatches(mac, this.mac(payload))) {
      this.reject(address, 'challenge expired or unknown');
    }
    const exp = Number(expStr);
    if (!Number.isInteger(exp) || exp <= Date.now()) {
      this.reject(address, 'challenge expired or unknown');
    }
    if (addr !== address) {
      this.reject(address, 'address mismatch');
    }

    if (!verifySep53(address, challenge, signature)) {
      this.reject(address, 'bad signature');
    }
    await this.people.proveWallet(address, 'SEP53');

    const role = await resolveRole(address, this.prisma, this.cfg.adminAddresses, 'session');
    this.logger.log(`verify OK addr=${address} role=${role}`);
    return this.mintFor(address, role);
  }

  private mintFor(address: string, role: 'admin' | 'lp' | 'user' = 'user'): Promise<string> {
    return this.jwt.signAsync(
      { sub: address, role, cls: 'session' },
      jwtSignOptions(this.cfg),
    );
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.cfg.jwtSecret).update(payload).digest('hex');
  }

  private macMatches(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');

    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }

}
