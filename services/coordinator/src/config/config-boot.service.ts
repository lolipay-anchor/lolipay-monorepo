import { Networks } from '@stellar/stellar-sdk';
import { windowsFitTheContract } from './contract-limits';
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { platformWalletRemedy } from './platform-wallet-remedy';
import { RPC_TIMEOUT_MS } from '../stellar/stellar-read.service';

export const BOOT_CHAIN_READ_MS = 2 * RPC_TIMEOUT_MS + 1000;
import { PrismaService } from '../prisma/prisma.service';
import { AppConfigService } from './app-config.service';
import { StellarReadService, withRpcTimeout } from '../stellar/stellar-read.service';
import { spreadCoversPriceDeviation, platformFeeFitsSpread } from './rate-guard';

@Injectable()
export class ConfigBootService implements OnModuleInit {
  private readonly log = new Logger(ConfigBootService.name);

  constructor(
    private prisma: PrismaService,
    private cfg: AppConfigService,
    private readonly stellar: StellarReadService,
  ) {}

  async onModuleInit(): Promise<void> {
    const budgetRaw = (process.env.DIDIT_DAILY_SESSION_BUDGET ?? '').trim();
    if (budgetRaw !== '' && !(Number.isFinite(Number(budgetRaw)) && Number(budgetRaw) >= 0)) {
      throw new Error(
        `refusing to start: DIDIT_DAILY_SESSION_BUDGET is ${JSON.stringify(budgetRaw)}, which is not a number, and a spend ceiling that cannot be read would silently become the default`,
      );
    }

    const base = this.cfg.anchorBaseUrl ?? '';
    let parsed: URL | null = null;
    try {
      parsed = new URL(base);
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      parsed.protocol !== 'https:' ||
      !parsed.host ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        `refusing to start: ANCHOR_BASE_URL is ${JSON.stringify(base)}, and every URL this anchor hands a wallet is built from it — it must be a plain https origin with no credentials, query or fragment`,
      );
    }

    const rpc = this.cfg.rpcUrl;
    let rpcUrl: URL | null = null;
    try {
      rpcUrl = new URL(rpc);
    } catch {
      rpcUrl = null;
    }
    if (!rpcUrl || rpcUrl.protocol !== 'https:' || !rpcUrl.host || rpcUrl.username || rpcUrl.password) {
      throw new Error(
        'refusing to start: STELLAR_RPC_URL must be an https url with a host and no userinfo — the signing page hands it to the browser verbatim and builds its own content-security-policy from its origin, so a malformed one blocks every submit with nothing to show for it. A path and a query are admitted because providers use them, which means this check cannot stop an api key riding in one: the endpoint the browser is given must be keyless',
      );
    }

    if (this.cfg.diditApiKey && this.cfg.diditWorkflowId && !this.cfg.diditWebhookSecret) {
      throw new Error(
        'refusing to start: an identity provider is configured but DIDIT_WEBHOOK_SECRET is not, so every verdict it sends would be refused and no deposit could ever open',
      );
    }

    if (this.cfg.networkPassphrase === Networks.PUBLIC) {
      if (this.cfg.diditEnvironment !== 'live') {
        throw new Error(
          `refusing to start: DIDIT_ENVIRONMENT is ${this.cfg.diditEnvironment} while the network is public, and a mocked environment reports screenings that never happened`,
        );
      }
      if (!this.cfg.diditApiKey || !this.cfg.diditWorkflowId) {
        throw new Error(
          'refusing to start: the network is public and no identity verification provider is configured, so every customer would be accepted by a stub',
        );
      }
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
    const feeProblem = platformFeeFitsSpread(row.platformFeeBps, row.spreadBps, this.cfg.priceDeviationMaxBps);
    if (feeProblem) {
      throw new Error(`refusing to start: ${feeProblem}`);
    }
    let chain: { platformFeeBps: number; platformWallet: string } | undefined;
    try {
      chain = await withRpcTimeout(this.stellar.readEscrowPlatformDefaults(this.cfg.escrowContractId), 'escrow get_config', BOOT_CHAIN_READ_MS);
    } catch (err) {
      this.log.warn(`the escrow contract defaults could not be read at boot, so Config.platformFeeBps and platformWallet are unchecked against them until the drift tick runs: ${String(err)}`);
    }
    if (chain && chain.platformFeeBps !== row.platformFeeBps) {
      this.log.warn(
        `Config.platformFeeBps (${row.platformFeeBps}) differs from the escrow contract default_platform_fee_bps (${chain.platformFeeBps}); create_trade will refuse every funding until the row is patched to match, and the drift tick will keep alerting`,
      );
    }
    if (chain && chain.platformWallet !== row.platformWallet) {
      this.log.warn(
        `Config.platformWallet (${row.platformWallet}) differs from the escrow contract default_platform_wallet (${chain.platformWallet}); create_trade will refuse every funding ${platformWalletRemedy(chain.platformWallet)}, and the drift tick will keep alerting`,
      );
    }
    const windowProblem = windowsFitTheContract(row.payWindowSecs, row.confirmWindowSecs, row.disputeWindowSecs);
    if (windowProblem) {
      throw new Error(`refusing to start: ${windowProblem}`);
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
