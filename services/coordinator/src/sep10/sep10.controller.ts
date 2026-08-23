import { Controller, Get, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ChallengeQueryDto } from './dto/challenge-query.dto';
import { Challenge, Sep10Service } from './sep10.service';

@Controller('auth')
export class Sep10Controller {
  constructor(private sep10: Sep10Service) {}

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Get()
  challenge(@Query() query: ChallengeQueryDto): Challenge {
    return this.sep10.buildChallenge(query.account, { memo: query.memo });
  }
}
