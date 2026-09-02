import { Throttle } from '@nestjs/throttler';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AllowTokenClasses } from '../auth/token-class.interceptor';
import { accountOf } from '../sep10/account-signers.service';
import { CustomerQueryDto } from './dto/customer-query.dto';
import { CustomerPutDto } from './dto/customer-put.dto';
import { Sep12Service } from './sep12.service';

function speaksFor(subject: string): { account: string; memo?: string } {
  const memo = subject.split(':')[1];
  try {
    return { account: accountOf(subject), memo };
  } catch {
    throw new NotFoundException('this token names an account that cannot be read');
  }
}

@Controller('customer')
@UseGuards(AuthGuard('jwt'))
export class Sep12Controller {
  constructor(private sep12: Sep12Service) {}

  @Get()
  @AllowTokenClasses('sep10')
  async get(@Req() req: any, @Query() query: CustomerQueryDto) {
    const subject: string = req.user.address;
    const speaking = speaksFor(subject);
    if (query.id !== undefined && query.id !== subject) {
      throw new NotFoundException('no customer by that id belongs to this account');
    }
    if (query.account !== undefined && query.account !== speaking.account) {
      throw new NotFoundException('no customer by that account belongs to this token');
    }
    if (query.memo !== undefined && query.memo !== speaking.memo) {
      throw new NotFoundException('no customer by that memo belongs to this token');
    }
    return this.sep12.get(subject);
  }

  @Delete(':account')
  @HttpCode(200)
  @AllowTokenClasses('sep10')
  async forget(@Req() req: any, @Param('account') account: string) {
    const subject: string = req.user.address;
    if (account !== subject && account !== speaksFor(subject).account) {
      throw new ForbiddenException('this token does not speak for that account');
    }
    const forgotten = await this.sep12.forget(subject);
    if (forgotten === 0) throw new NotFoundException('this anchor holds nothing about that customer');
  }

  @Throttle({ default: { ttl: 3_600_000, limit: 10 } })
  @Put()
  @HttpCode(202)
  @AllowTokenClasses('sep10')
  async put(@Req() req: any, @Body() dto: CustomerPutDto) {
    const subject: string = req.user.address;
    const speaking = speaksFor(subject);
    if (dto.account !== undefined && dto.account !== speaking.account) {
      throw new BadRequestException('account does not match the account this token speaks for');
    }
    if (dto.memo !== undefined && dto.memo !== speaking.memo) {
      throw new BadRequestException('memo does not match the memo this token carries');
    }
    const { account: _a, memo: _m, memo_type: _mt, type: _t, ...fields } = dto;
    return this.sep12.put(subject, fields as Record<string, string>);
  }
}
