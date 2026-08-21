import {
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
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { AdminService, MetricsOverview, OrderRisk } from './admin.service';
import { SetLpStatusDto } from './dto/set-lp-status.dto';
import { RegisterLpDto } from './dto/register-lp.dto';
import { UpdateConfigDto } from './dto/update-config.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { ListLpsQueryDto } from './dto/list-lps-query.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { MetricsOverviewQueryDto } from './dto/metrics-overview-query.dto';
import { postSettleDisputeDeadline } from '../order/dispute.util';

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
  registerLp(@Body() dto: RegisterLpDto) {
    return this.admin.register(dto);
  }

  @Post('lps/:id/approve')
  @HttpCode(200)
  approveLp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'APPROVED', dto.note);
  }

  @Post('lps/:id/suspend')
  @HttpCode(200)
  suspendLp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'SUSPENDED', dto.note);
  }

  @Post('lps/:id/revoke')
  @HttpCode(200)
  revokeLp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetLpStatusDto) {
    return this.admin.setStatus(id, 'REVOKED', dto.note);
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
  async updateConfig(@Body() dto: UpdateConfigDto) {
    try {
      const updated = await this.admin.updateConfigTransactional(dto);
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
    @Param('code', ParseMarketCodePipe) code: string,
    @Body() dto: UpdateMarketDto,
  ) {
    const updated = await this.admin.updateMarket(code, dto);
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

function serializeOrderBase(
  order: any,
  config?: { postSettleDisputeWindowSecs: number } | null,
): Record<string, any> {
  return {
    id: order.id,
    trade_id: order.tradeId,
    user_address: order.userAddress,
    lp_wallet: order.lpWallet,
    flow: order.flow,
    rail: order.rail,
    usdc_amount: order.usdcAmount?.toString(),
    fiat_amount: order.fiatAmount?.toString(),
    fiat_currency: order.fiatCurrency,
    rate_snapshot: order.rateSnapshot,
    platform_fee_bps: order.platformFeeBps,
    lp_fee_bps: order.lpFeeBps,
    status: order.status,
    pay_deadline: Number(order.payDeadline),
    confirm_deadline: Number(order.confirmDeadline),
    dispute_deadline: Number(order.disputeDeadline),
    expires_at: order.expiresAt,
    created_at: order.createdAt,

    ref: order.ref ?? null,
    proof_url: order.proofUrl ?? null,
    proof_rrn: order.proofRrn ?? null,
    proof_amount: order.proofAmount != null ? order.proofAmount.toString() : null,
    proof_paid_at: order.proofPaidAt ?? null,
    settled_at: order.settledAt ?? null,
    dispute_by: order.disputeBy ?? null,
    dispute_reason: order.disputeReason ?? null,
    dispute_note: order.disputeNote ?? null,
    dispute_evidence_url: order.disputeEvidenceUrl ?? null,
    dispute_at: order.disputeAt ?? null,
    resolution: order.resolution ?? null,
    post_settle_dispute_until: config ? postSettleDisputeDeadline(order, config) : null,
  };
}
