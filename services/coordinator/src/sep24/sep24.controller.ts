import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { UseFilters } from '@nestjs/common';
import { InteractiveErrorFilter } from './interactive-error.filter';
import {
  originIsForeign,
  readCookies,
  sessionCookieName,
  sessionCookieOptions,
} from './interactive-session';
import { AppConfigService } from '../config/app-config.service';
import { REQUIRED_KYC_FIELDS } from '../kyc/kyc-provider';
import {
  SEP24_INTERACTIVE_TTL_SECS,
  mintInteractiveToken,
  readInteractiveToken,
} from './interactive-token';
import { renderSignScript } from './sign-script';
import { cspAllowingRpc } from './signing-csp';
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
    private cfg: AppConfigService,
  ) {}

  private usableSession(req: any, id: string): string {
    for (const held of readCookies(req?.headers?.cookie, sessionCookieName(id))) {
      try {
        const { account, abs } = readInteractiveToken(this.cfg, held, id);
        return mintInteractiveToken(
          this.cfg,
          id,
          account,
          SEP24_INTERACTIVE_TTL_SECS,
          'session',
          abs > 0 ? abs : undefined,
        );
      } catch {
        continue;
      }
    }
    return '';
  }

  private requireSession(req: any, id: string): void {
    if (!this.usableSession(req, id)) {
      throw new UnauthorizedException('this page needs the session this anchor set on it');
    }
  }

  private refuseForeignOrigin(req: any): void {
    if (originIsForeign(req?.headers?.origin, this.cfg.anchorBaseUrl)) {
      throw new ForbiddenException('this request did not come from the page this anchor served');
    }
  }

  @Post('transactions/deposit/interactive')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
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
    return this.sep24.openInteractive(subject, person.id, body, 'TOP_UP');
  }

  @Post('transactions/withdraw/interactive')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @UseInterceptors(AnyFilesInterceptor({ limits: { files: 0, fieldSize: 4096, fields: 40 } }))
  @HttpCode(200)
  @UseGuards(Sep24AuthGuard)
  @AllowTokenClasses('sep10')
  async openWithdraw(@Req() req: any, @Body() body: Record<string, unknown>) {
    if (!this.cfg.sep24WithdrawEnabled) {
      throw new ForbiddenException('this anchor does not offer withdrawal yet');
    }
    const subject: string = req.user.address;
    const person = await this.people.lookupPerson(subject);
    if (!person) {
      throw new ForbiddenException('this wallet is no longer permitted to open a withdrawal');
    }
    return this.sep24.openInteractive(subject, person.id, body, 'WITHDRAW');
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
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async interactive(
    @Req() req: any,
    @Param('id') id: string,
    @Query('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('content-security-policy', cspAllowingRpc(this.cfg.rpcUrl));
    const held = this.usableSession(req, id);
    if (held) {
      res.cookie(sessionCookieName(id), held, sessionCookieOptions(id));
      return this.sep24.renderInteractive(id, held);
    }

    const fromUrl = String(token ?? '');
    if (fromUrl) {
      const session = await this.sep24.sessionFromLink(id, fromUrl);
      res.cookie(sessionCookieName(id), session, sessionCookieOptions(id));
      res.redirect(302, `/sep24/interactive/${encodeURIComponent(id)}`);
      return undefined;
    }
    return this.sep24.renderInteractive(id, '');
  }

  @UseFilters(InteractiveErrorFilter)
  @Post('interactive/:id/identity')
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async identity(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.refuseForeignOrigin(req);
    const token = this.usableSession(req, id);
    const fields: Record<string, string> = {};
    for (const f of REQUIRED_KYC_FIELDS) {
      const v = (body ?? {})[f];
      if (typeof v === 'string') fields[f] = v;
    }
    const url = await this.sep24.submitIdentity(id, token, fields);
    if (!url) {
      res.redirect(302, `/sep24/interactive/${encodeURIComponent(id)}`);
      return undefined;
    }
    return this.sep24.verificationHandoff(url);
  }

  @UseFilters(InteractiveErrorFilter)
  @Post('interactive/:id/amount')
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Throttle({ default: { ttl: 3_600_000, limit: 60 } })
  @Header('cache-control', 'no-store')
  async amount(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.refuseForeignOrigin(req);
    const token = this.usableSession(req, id);
    await this.sep24.submitAmount(id, token, body.fiat_amount, body.user_payment_method);
    res.redirect(302, `/sep24/interactive/${encodeURIComponent(id)}`);
  }

  @Get('interactive/:id/fund-tx')
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Header('cache-control', 'no-store')
  async fundTx(@Req() req: any, @Param('id') id: string) {
    this.refuseForeignOrigin(req);
    const token = this.usableSession(req, id);
    return this.sep24.fundTx(id, token);
  }

  @Get('interactive/:id/release-tx')
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Throttle({ default: { ttl: 3_600_000, limit: 20 } })
  @Header('cache-control', 'no-store')
  async releaseTx(@Req() req: any, @Param('id') id: string) {
    this.refuseForeignOrigin(req);
    const token = this.usableSession(req, id);
    return this.sep24.releaseTx(id, token);
  }

  @Get('interactive/:id/fund.js')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Header('content-type', 'application/javascript; charset=utf-8')
  @Header('cache-control', 'no-store')
  fundScript(@Req() req: any, @Param('id') id: string): string {
    this.requireSession(req, id);
    return renderSignScript(id, 'fund', this.cfg.rpcUrl);
  }

  @Get('interactive/:id/release.js')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('cross-origin-opener-policy', 'unsafe-none')
  @Header('content-type', 'application/javascript; charset=utf-8')
  @Header('cache-control', 'no-store')
  releaseScript(@Req() req: any, @Param('id') id: string): string {
    this.requireSession(req, id);
    return renderSignScript(id, 'release', this.cfg.rpcUrl);
  }

  @Get('more-info/:id')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  async moreInfo(@Param('id') id: string, @Res({ passthrough: true }) _res: Response) {
    return this.sep24.moreInfo(id);
  }
}
