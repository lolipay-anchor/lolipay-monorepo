import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { baseStellarAccount } from '../sep10/account-signers.service';
import { AuthGuard } from '@nestjs/passport';
import { AllowTokenClasses } from '../auth/token-class.interceptor';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { CustomerPutDto } from './dto/customer-put.dto';
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

  @Delete(':account')
  @HttpCode(200)
  @AllowTokenClasses('sep10')
  async forget(@Req() req: any, @Param('account') account: string) {
    const subject: string = req.user.address;
    if (account !== baseStellarAccount(subject.split(':')[0])) {
      throw new ForbiddenException('this token does not speak for that account');
    }
    await this.sep12.forget(subject);
  }

  @Put()
  @HttpCode(202)
  @AllowTokenClasses('sep10')
  async put(@Req() req: any, @Body() dto: CustomerPutDto) {
    const { account: _a, memo: _m, memo_type: _mt, type: _t, ...fields } = dto;
    return this.sep12.put(req.user.address, fields as Record<string, string>);
  }
}
