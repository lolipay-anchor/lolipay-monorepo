import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  PipeTransform,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminService, MetricsOverview, OrderRisk } from './admin.service';
import { SetLpStatusDto } from './dto/set-lp-status.dto';
import { AttestFiatPaidDto } from './dto/attest-fiat-paid.dto';
import { RegisterLpDto } from './dto/register-lp.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { ListLpsQueryDto } from './dto/list-lps-query.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { MetricsOverviewQueryDto } from './dto/metrics-overview-query.dto';
import { serializeOrderBase } from '../order/order.serialize';

@Injectable()
class ParseMarketCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
      throw new BadRequestException('code must be a 3-letter uppercase market code (e.g. IDR)');
    }
    return value;
  }
}

@Controller('admin')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('lps')
  listLps(@Query() query: ListLpsQueryDto) {
    return this.admin.list(query.status);
  }

  @Post('lps')
  registerLp(@Req() req: any, @Body() dto: RegisterLpDto) {
    return this.admin.register(dto, req.user.address);
  }

  @Post('lps/:id/approve')
  @HttpCode(200)
  approveLp(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'APPROVED', dto.note, req.user.address);
  }

  @Post('lps/:id/suspend')
  @HttpCode(200)
  suspendLp(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'SUSPENDED', dto.note, req.user.address);
  }

  @Post('lps/:id/revoke')
  @HttpCode(200)
  revokeLp(@Req() req: any, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'REVOKED', dto.note, req.user.address);
  }

  @Get('orders')
  async listOrders(@Query() query: ListOrdersQueryDto) {
    const [orders, config] = await Promise.all([
      this.admin.listOrders(query.status, {
        take: query.limit ?? 50,
        skip: query.offset ?? 0,
      }),
      this.admin.config(),
    ]);

    return orders.map((o) => serializeOrderBase(o, config));
  }

  @Get('orders/:id/risk')
  async getOrderRisk(@Param('id', ParseUUIDPipe) id: string) {
    const risk = await this.admin.getOrderRisk(id);
    return serializeOrderRisk(risk);
  }

  @Get('metrics/overview')
  async getMetricsOverview(@Query() query: MetricsOverviewQueryDto) {
    const overview = await this.admin.getMetricsOverview(query.range ?? '24h');
    return serializeMetricsOverview(overview);
  }

  @Get('config')
  async getConfig() {
    const cfg = await this.admin.config();
    return this.serializeConfig(cfg);
  }

  @Patch('config')
  async updateConfig(@Req() req: any, @Body() dto: UpdateConfigDto) {
    try {
      const updated = await this.admin.updateConfigTransactional(dto, req.user.address);
      return this.serializeConfig(updated);
    } catch (err: any) {
      if (err?.message === 'BPS_OVERFLOW') {
        throw new BadRequestException(
          'platformFeeBps + lpFeeBps must be less than 10000 (100%)',
        );
      }
      if (err?.message === 'ORDER_BOUNDS_INVALID') {
        throw new BadRequestException('minOrder must be less than maxOrder');
      }
      if (typeof err?.message === 'string' && err.message.startsWith('SPREAD_TOO_NARROW: ')) {
        throw new BadRequestException(err.message.slice('SPREAD_TOO_NARROW: '.length));
      }
      if (typeof err?.message === 'string' && err.message.startsWith('PLATFORM_FEE_EXCEEDS_SPREAD: ')) {
        throw new BadRequestException(err.message.slice('PLATFORM_FEE_EXCEEDS_SPREAD: '.length));
      }
      if (typeof err?.message === 'string' && err.message.startsWith('PLATFORM_FEE_DIVERGES_FROM_CHAIN: ')) {
        throw new BadRequestException(err.message.slice('PLATFORM_FEE_DIVERGES_FROM_CHAIN: '.length));
      }
      if (typeof err?.message === 'string' && err.message.startsWith('PLATFORM_WALLET_DIVERGES_FROM_CHAIN: ')) {
        throw new BadRequestException(err.message.slice('PLATFORM_WALLET_DIVERGES_FROM_CHAIN: '.length));
      }
      if (typeof err?.message === 'string' && err.message.startsWith('ESCROW_CONFIG_UNREADABLE: ')) {
        throw new BadGatewayException(err.message.slice('ESCROW_CONFIG_UNREADABLE: '.length));
      }
      if (typeof err?.message === 'string' && err.message.startsWith('WINDOW_BOUNDS_INVALID: ')) {
        throw new BadRequestException(
          `${err.message.slice('WINDOW_BOUNDS_INVALID: '.length)} — the escrow contract would reject every order created with these windows`,
        );
      }
      throw err;
    }
  }

  @Get('markets')
  async listMarkets() {
    const rows = await this.admin.listMarkets();
    return rows.map(serializeMarket);
  }

  @Patch('markets/:code')
  async updateMarket(
    @Req() req: any,
    @Param('code', ParseMarketCodePipe) code: string,
    @Body() dto: UpdateMarketDto,
  ) {
    const updated = await this.admin.updateMarket(code, dto, req.user.address);
    return serializeMarket(updated);
  }

  private serializeConfig(cfg: any) {
    if (!cfg) return cfg;
    return {
      ...cfg,
      minOrder: cfg.minOrder?.toString(),
      maxOrder: cfg.maxOrder?.toString(),
    };
  }

  @Post('orders/:id/attest')
  @HttpCode(200)
  attestFiatPaid(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttestFiatPaidDto,
  ) {
    return this.admin.attestFiatPaid(id, req.user.address, dto.evidence);
  }
}

function serializeMarket(m: any): Record<string, any> {
  return {
    code: m.code,
    country: m.country,
    currency_symbol: m.currencySymbol,
    locale: m.locale,
    rail_name: m.railName,
    rate_source: m.rateSource,
    manual_rate_override: m.manualRateOverride,
    price_min_per_usdc: m.priceMinPerUsdc,
    price_max_per_usdc: m.priceMaxPerUsdc,
    decimals: m.decimals,
    enabled: m.enabled,
    updated_at: m.updatedAt,
  };
}

function serializeOrderRisk(risk: OrderRisk): Record<string, any> {
  return {
    wallet_age_days: risk.walletAgeDays,
    user_dispute_velocity_30d: risk.userDisputeVelocity30d,
    lp_dispute_velocity_30d: risk.lpDisputeVelocity30d,
    amount_vs_tier_limit: {
      order_usdc: risk.amountVsTierLimit.orderUsdc,
      tier: risk.amountVsTierLimit.tier,
      daily_limit_usdc: risk.amountVsTierLimit.dailyLimitUsdc,
      ratio: risk.amountVsTierLimit.ratio,
    },

    lp_completion: risk.lpCompletion,
  };
}

function serializeMetricsOverview(m: MetricsOverview): Record<string, any> {
  return {
    range: m.range,
    volume_usdc: m.volumeUsdc,
    fees_usdc: m.feesUsdc,
    avg_settle_secs: m.avgSettleSecs,
    open_disputes: m.openDisputes,
    orders_count: m.ordersCount,
    daily_bars: m.dailyBars.map((d) => ({ date: d.date, volume_usdc: d.volumeUsdc })),
    flow_mix: m.flowMix.map((f) => ({ flow: f.flow, count: f.count, volume_usdc: f.volumeUsdc })),
    top_lps: m.topLps.map((l) => ({
      lp_id: l.lpId,
      address: l.address,
      volume_usdc: l.volumeUsdc,
      trades: l.trades,
    })),
  };
}
