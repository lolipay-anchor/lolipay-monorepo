import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from './app-config.service';
import { spreadCoversPriceDeviation } from './rate-guard';

@Injectable()
export class ConfigBootService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const row = await this.prisma.config.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, platformWallet: this.cfg.platformWallet },
    });

    const problem = spreadCoversPriceDeviation(row.spreadBps, this.cfg.priceDeviationMaxBps);
    if (problem) {
      throw new Error(`refusing to start: ${problem}`);
    }

    if (!row.platformWallet) {
      throw new Error(
        'refusing to start: Config.platformWallet is empty, so every escrow lock would route the ' +
          'platform fee to no account and order creation would fail on-chain. Seed it first.',
      );
    }

    if (row.platformWallet !== this.cfg.platformWallet) {
      console.warn(
        `Config.platformWallet (${row.platformWallet}) differs from PLATFORM_WALLET ` +
          `(${this.cfg.platformWallet}); the stored value is the one that routes fees`,
      );
    }
  }
}
