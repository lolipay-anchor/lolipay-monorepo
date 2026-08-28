import { Controller, Get, Header, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Sep24AuthGuard } from './sep24-auth.guard';
import { Sep24Service } from './sep24.service';
import { AllowTokenClasses } from '../auth/token-class.interceptor';

@Controller('sep24')
export class Sep24Controller {
  constructor(private sep24: Sep24Service) {}

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
