import {
  Body, Controller, ForbiddenException, Get, Header, HttpCode, Param, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Sep24AuthGuard } from './sep24-auth.guard';
import { Sep24Service } from './sep24.service';
import { AllowTokenClasses } from '../auth/token-class.interceptor';
import { DepositInteractiveDto } from './deposit-interactive.dto';
import { PersonService } from '../person/person.service';

@Controller('sep24')
export class Sep24Controller {
  constructor(
    private sep24: Sep24Service,
    private people: PersonService,
  ) {}

  @Post('transactions/deposit/interactive')
  @HttpCode(200)
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async openDeposit(@Req() req: any, @Body() body: DepositInteractiveDto) {
    const subject: string = req.user.address;
    const person = await this.people.lookupPerson(subject);
    if (!person) {
      throw new ForbiddenException('this wallet is no longer permitted to open a deposit');
    }
    return this.sep24.openInteractive(subject, person.id, body);
  }

  @Get('info')
  async info() {
    return this.sep24.info();
  }

  @Get('transactions')
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async list(@Req() req: any, @Query() query: Record<string, string>) {
    return this.sep24.list(req.user.address, query);
  }

  @Get('transaction')
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async one(@Req() req: any, @Query() query: Record<string, string>) {
    return this.sep24.one(req.user.address, query);
  }

  @Get('more-info/:id')
  @Header('content-type', 'text/html; charset=utf-8')
  async moreInfo(@Param('id') id: string, @Res({ passthrough: true }) _res: Response) {
    return this.sep24.moreInfo(id);
  }
}
