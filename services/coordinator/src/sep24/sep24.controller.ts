import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UseFilters } from '@nestjs/common';
import { InteractiveErrorFilter } from './interactive-error.filter';
import { UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { Sep24AuthGuard } from './sep24-auth.guard';
import { Sep24Service } from './sep24.service';
import { AllowTokenClasses } from '../auth/token-class.interceptor';
import { TransactionsQueryDto, TransactionQueryDto } from './sep24-query.dto';
import { PersonService } from '../person/person.service';

@Controller('sep24')
export class Sep24Controller {
  constructor(
    private sep24: Sep24Service,
    private people: PersonService,
  ) {}

  @Post('transactions/deposit/interactive')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 0, fieldSize: 4096, fields: 40 } }))
  @HttpCode(200)
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async openDeposit(@Req() req: any, @Body() body: Record<string, unknown>) {
    const subject: string = req.user.address;
    const person = await this.people.lookupPerson(subject);
    if (!person) {
      throw new ForbiddenException('this wallet is no longer permitted to open a deposit');
    }
    return this.sep24.openInteractive(subject, person.id, body);
  }

  @Get('info')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async info() {
    return this.sep24.info();
  }

  @Get('transactions')
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async list(@Req() req: any, @Query() query: TransactionsQueryDto) {
    return this.sep24.list(req.user.address, query);
  }

  @Get('transaction')
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async one(@Req() req: any, @Query() query: TransactionQueryDto) {
    return this.sep24.one(req.user.address, query);
  }

  @UseFilters(InteractiveErrorFilter)
  @Get('interactive/:id')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('content-type', 'text/html; charset=utf-8')
  async interactive(@Param('id') id: string, @Query('token') token: string) {
    return this.sep24.renderInteractive(id, String(token ?? ''));
  }

  @UseFilters(InteractiveErrorFilter)
  @Post('interactive/:id/identity')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Header('content-type', 'text/html; charset=utf-8')
  async identity(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (typeof v === 'string') fields[k] = v;
    }
    const url = await this.sep24.submitIdentity(id, String(token ?? ''), fields);
    if (!url) {
      res.redirect(302, this.sep24.interactiveUrl(id, String(token ?? '')));
      return undefined;
    }
    return this.sep24.verificationHandoff(url);
  }

  @UseFilters(InteractiveErrorFilter)
  @Post('interactive/:id/amount')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  async amount(
    @Param('id') id: string,
    @Query('token') token: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.sep24.submitAmount(id, String(token ?? ''), body.fiat_amount);
    res.redirect(302, this.sep24.interactiveUrl(id, String(token ?? '')));
  }

  @Get('more-info/:id')
  @Header('content-type', 'text/html; charset=utf-8')
  async moreInfo(@Param('id') id: string, @Res({ passthrough: true }) _res: Response) {
    return this.sep24.moreInfo(id);
  }
}
