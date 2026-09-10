import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { LpService, LpEarnings } from './lp.service';
import { ApplyLpDto } from './dto/apply-lp.dto';
import { AddPaymentMethodDto } from './dto/add-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { StakeTxQueryDto } from './dto/stake-query.dto';

@Controller('lp')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class LpController {
  constructor(private lp: LpService) {}

  @Post('apply')
  @Roles('user', 'lp', 'admin')
  async apply(@Req() req: any, @Body() dto: ApplyLpDto) {
    return this.lp.apply(req.user.address, dto.contact, dto.liquidityProof);
  }

  @Get('me')
  @Roles('user', 'lp', 'admin')
  async me(@Req() req: any) {
    return this.lp.me(req.user.address);
  }

  @Get('earnings')
  @Roles('lp')
  async earnings(@Req() req: any) {
    const earnings = await this.lp.getEarnings(req.user.address);
    return serializeLpEarnings(earnings);
  }

  @Post('heartbeat')
  @HttpCode(200)
  @Roles('lp')
  async heartbeat(@Req() req: any) {
    await this.lp.heartbeat(req.user.address);
    return { ok: true };
  }

  @Post('availability')
  @HttpCode(200)
  @Roles('lp')
  async setAvailability(@Req() req: any, @Body() dto: SetAvailabilityDto) {
    await this.lp.setAvailability(req.user.address, dto.available);
    return { ok: true };
  }

  @Post('payment-methods')
  @Roles('lp')
  async addPaymentMethod(@Req() req: any, @Body() dto: AddPaymentMethodDto) {
    return this.lp.addPaymentMethod(req.user.address, dto.rail as any, dto.label, dto.details);
  }

  @Patch('payment-methods/:id')
  @Roles('lp')
  async updatePaymentMethod(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentMethodDto,
  ) {
    return this.lp.updatePaymentMethod(req.user.address, id, {
      rail: dto.rail as any,
      label: dto.label,
      details: dto.details,
      active: dto.active,
    });
  }

  @Delete('payment-methods/:id')
  @HttpCode(200)
  @Roles('lp')
  async deletePaymentMethod(@Req() req: any, @Param('id') id: string) {
    await this.lp.deletePaymentMethod(req.user.address, id);
    return { ok: true };
  }

  @Get('tx/stake')
  @Roles('lp')
  async buildStakeTx(@Req() req: any, @Query() query: StakeTxQueryDto) {
    return this.lp.buildStakeTx(req.user.address, query.amount);
  }

  @Get('tx/request-unstake')
  @Roles('user', 'lp', 'admin')
  async buildRequestUnstakeTx(@Req() req: any, @Query() query: StakeTxQueryDto) {
    return this.lp.buildRequestUnstakeTx(req.user.address, query.amount);
  }

  @Get('tx/claim-unstake')
  @Roles('user', 'lp', 'admin')
  async buildClaimUnstakeTx(@Req() req: any) {
    return this.lp.buildClaimUnstakeTx(req.user.address);
  }

  @Get('eligibility')
  @Roles('user', 'lp', 'admin')
  async getEligibility(@Req() req: any) {
    return this.lp.getStakeInfo(req.user.address);
  }
}

function serializeLpEarnings(e: LpEarnings): Record<string, any> {
  return {
    today_trades: e.todayTrades,
    today_earned_usdc: e.todayEarnedUsdc,
    today_volume_usdc: e.todayVolumeUsdc,
    week_bars: e.weekBars.map((b) => ({
      date: b.date,
      volume_usdc: b.volumeUsdc,
      earned_usdc: b.earnedUsdc,
    })),
    all_time_trades: e.allTimeTrades,
    all_time_earned_usdc: e.allTimeEarnedUsdc,
  };
}
