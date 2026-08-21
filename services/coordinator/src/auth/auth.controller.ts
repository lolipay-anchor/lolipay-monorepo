import { Body, Controller, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ChallengeDto } from './dto/challenge.dto';
import { VerifyDto } from './dto/verify.dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('challenge')
  challenge(@Body() dto: ChallengeDto) {
    return { nonce: this.auth.issueChallenge(dto.address) };
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('verify')
  async verify(@Body() dto: VerifyDto) {
    return { jwt: await this.auth.verify(dto.address, dto.nonce, dto.signature) };
  }
}
