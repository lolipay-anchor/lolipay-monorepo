import { Networks } from '@stellar/stellar-sdk';
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
    if (this.cfg.kycStubScreens && this.cfg.networkPassphrase === Networks.PUBLIC) {
      throw new Error(
        'refusing to start: KYC_STUB_SCREENS is on while the network is public, so a stub that performs no sanctions screening would be reporting that it had',
      );
    }
    if (!this.cfg.usdcAssetCode) {
      throw new Error(
        'refusing to start: USDC_ASSET_CODE is empty, so the coordinator does not know which asset the escrow settles in',
      );
    }
    if (!/^G[A-Z2-7]{55}$/.test(this.cfg.usdcAssetIssuer)) {
      throw new Error(
        `refusing to start: USDC_ASSET_ISSUER must be the Stellar address that issues ${this.cfg.usdcAssetCode} — every trustline check compares issuer as well as code, so an unset one silently refuses every order`,
      );
    }

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
