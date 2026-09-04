import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export function parseCorsOrigins(raw: string | undefined | null): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

@Injectable()
export class AppConfigService {
  constructor(private c: ConfigService) {}

  get corsOrigins(): string[] { return parseCorsOrigins(this.c.get<string>('CORS_ORIGINS')); }
  get jwtSecret() {
    const s = this.req('JWT_SECRET');

    if (s.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 chars (use `openssl rand -hex 32`)');
    }
    return s;
  }
  get jwtTtl() { return Number(this.c.get('JWT_TTL_SECONDS') ?? 900); }
  get jwtIssuer() { return String(this.c.get('JWT_ISSUER') ?? 'https://lolipay.app'); }
  get jwtAudience() { return String(this.c.get('JWT_AUDIENCE') ?? 'lolipay-app'); }
  get sep10SigningKey() { return this.c.get<string>('SEP10_SIGNING_KEY'); }
  get anchorHomeDomain() { return this.c.get<string>('ANCHOR_HOME_DOMAIN'); }
  get sep10WebAuthDomain() { return this.c.get<string>('SEP10_WEB_AUTH_DOMAIN'); }
  get anchorBaseUrl(): string {
    const raw = (this.c.get<string>('ANCHOR_BASE_URL') ?? '').trim();
    return raw.endsWith('/') ? raw.slice(0, -1) : raw;
  }
  get challengeTtl() { return Number(this.c.get('AUTH_CHALLENGE_TTL_SECONDS') ?? 120); }
  get adminAddresses() { return (this.c.get<string>('ADMIN_ADDRESSES') ?? '').split(',').map(s => s.trim()).filter(Boolean); }
  get rpcUrl() { return this.req('STELLAR_RPC_URL'); }
  get networkPassphrase() { return this.req('STELLAR_NETWORK_PASSPHRASE'); }
  get diditWebhookSecret(): string { return this.c.get<string>('DIDIT_WEBHOOK_SECRET') ?? ''; }
  get diditApiKey(): string { return this.c.get<string>('DIDIT_API_KEY') ?? ''; }
  get diditWorkflowId(): string { return this.c.get<string>('DIDIT_WORKFLOW_ID') ?? ''; }
  get diditEnvironment(): string { return this.c.get<string>('DIDIT_ENVIRONMENT') ?? 'live'; }
  get diditDailySessionBudget(): number {
    const raw = (this.c.get<string>('DIDIT_DAILY_SESSION_BUDGET') ?? '').trim();
    if (raw === '') return 200;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
  }
  get stakingContractId() { return this.req('STAKING_CONTRACT_ID'); }
  get escrowContractId() { return this.req('ESCROW_CONTRACT_ID'); }

  get escrowContractIdsExtra(): string[] {
    return (this.c.get<string>('ESCROW_CONTRACT_IDS_EXTRA') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  get priceStaleSecs() { return Number(this.c.get('PRICE_STALE_SECONDS') ?? 120); }
  get priceDeviationMaxBps() { return Number(this.c.get('PRICE_DEVIATION_MAX_BPS') ?? 100); }
  get platformWallet(): string {
    const w = this.req('PLATFORM_WALLET');
    if (!/^G[A-Z2-7]{55}$/.test(w)) throw new Error(`PLATFORM_WALLET is not a valid Stellar public key: "${w}"`);
    return w;
  }

  get alertWebhookUrl() {
    const raw = this.c.get<string>('ALERT_WEBHOOK_URL') || undefined;
    if (!raw) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error('ALERT_WEBHOOK_URL is not a URL — check for a missing scheme or a stray space');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(
        'ALERT_WEBHOOK_URL must be https — the path is a bearer credential and would travel in the clear',
      );
    }
    return raw;
  }

  get horizonUrl() { return this.c.get<string>('HORIZON_URL') ?? 'https://horizon-testnet.stellar.org'; }
  get usdcAssetCode() { return this.c.get<string>('USDC_ASSET_CODE') ?? ''; }
  get usdcAssetIssuer() {
    return this.c.get<string>('USDC_ASSET_ISSUER') ?? '';
  }

  get stellarReadKey(): string | undefined {
    const v = this.c.get<string>('STELLAR_READ_KEY') || undefined;
    if (v && !/^G[A-Z2-7]{55}$/.test(v)) throw new Error(`STELLAR_READ_KEY must be a Stellar G-address (public key): "${v}"`);
    return v;
  }

  get refundSignerSecret(): string | undefined {
    return this.c.get<string>('REFUND_SIGNER_SECRET') || undefined;
  }

  get attestorSecret(): string | undefined {
    return this.c.get<string>('ATTESTOR_SECRET') || undefined;
  }

  get minioEndpoint(): string { return this.req('MINIO_ENDPOINT'); }
  get minioPort(): number { return Number(this.c.get<string>('MINIO_PORT') ?? 9000); }
  get minioUseSSL(): boolean { return (this.c.get<string>('MINIO_USE_SSL') ?? 'false').toLowerCase() === 'true'; }

  get kycRequireAml(): boolean { return (this.c.get<string>('KYC_REQUIRE_AML') ?? 'true').trim().toLowerCase() !== 'false'; }
  get sep24WithdrawEnabled(): boolean { return (this.c.get<string>('SEP24_WITHDRAW_ENABLED') ?? 'false').trim().toLowerCase() === 'true'; }
  get minioAccessKey(): string { return this.req('MINIO_ACCESS_KEY'); }
  get minioSecretKey(): string { return this.req('MINIO_SECRET_KEY'); }
  get minioBucket(): string { return this.c.get<string>('MINIO_BUCKET') ?? 'lolipay-uploads'; }
  private req(k: string): string { const v = this.c.get<string>(k); if (!v) throw new Error(`Missing env ${k}`); return v; }
}
