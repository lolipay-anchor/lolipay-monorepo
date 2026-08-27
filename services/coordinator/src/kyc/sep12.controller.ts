import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AllowTokenClasses } from '../auth/token-class.interceptor';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { Sep12Service } from './sep12.service';

@Controller('customer')
@UseGuards(AuthGuard('jwt'))
export class Sep12Controller {
  constructor(private sep12: Sep12Service) {}

  @Get()
  @AllowTokenClasses('sep10')
  async get(@Req() req: any, @Query() _query: CustomerQueryDto) {
    return this.sep12.get(req.user.address);
  }
}
