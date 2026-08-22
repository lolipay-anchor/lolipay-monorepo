import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { UserReputationService } from '../reputation/user-reputation.service';
import { baseUnitsToUsdc } from '../money/money';

@Controller('profile')
@UseGuards(AuthGuard('jwt'), RolesGuard)
export class ProfileController {
  constructor(
    private userReputation: UserReputationService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async getProfile(@Req() req: any): Promise<Record<string, unknown>> {
    const address: string = req.user.address;
    const personId = await this.userReputation.personIdFor(address);
    const [reputation, config, usedBase] = await Promise.all([
      this.userReputation.getReputation(personId),
      this.prisma.config.findUnique({ where: { id: 1 } }),
      this.userReputation.used24hBaseUnits(personId),
    ]);

    const limitBase = this.userReputation.dailyLimitBaseUnits(reputation.tier, config);

    const remainingBase = limitBase > usedBase ? limitBase - usedBase : 0n;

    return {
      tier: reputation.tier,
      completed_trades: reputation.completedTrades,
      disputes_lost: reputation.disputesLost,
      completion_rate: reputation.completionRate,
      daily_limit_usdc: baseUnitsToUsdc(limitBase),
      daily_used_usdc: baseUnitsToUsdc(usedBase),
      daily_remaining_usdc: baseUnitsToUsdc(remainingBase),
    };
  }
}
