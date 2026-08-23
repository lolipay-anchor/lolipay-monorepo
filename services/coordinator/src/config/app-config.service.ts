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
  get challengeTtl() { return Number(this.c.get('AUTH_CHALLENGE_TTL_SECONDS') ?? 120); }
  get adminAddresses() { return (this.c.get<string>('ADMIN_ADDRESSES') ?? '').split(',').map(s => s.trim()).filter(Boolean); }
  get rpcUrl() { return this.req('STELLAR_RPC_URL'); }
  get networkPassphrase() { return this.req('STELLAR_NETWORK_PASSPHRASE'); }
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

  get alertWebhookUrl() { return this.c.get<string>('ALERT_WEBHOOK_URL') || undefined; }

  get horizonUrl() { return this.c.get<string>('HORIZON_URL') ?? 'https://horizon-testnet.stellar.org'; }
  get usdcAssetCode() { return this.c.get<string>('USDC_ASSET_CODE') ?? 'TUSDC'; }
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

  get minioEndpoint(): string { return this.req('MINIO_ENDPOINT'); }
  get minioPort(): number { return Number(this.c.get<string>('MINIO_PORT') ?? 9000); }
  get minioUseSSL(): boolean { return (this.c.get<string>('MINIO_USE_SSL') ?? 'false').toLowerCase() === 'true'; }
  get minioAccessKey(): string { return this.req('MINIO_ACCESS_KEY'); }
  get minioSecretKey(): string { return this.req('MINIO_SECRET_KEY'); }
  get minioBucket(): string { return this.c.get<string>('MINIO_BUCKET') ?? 'lolipay-uploads'; }
  private req(k: string): string { const v = this.c.get<string>(k); if (!v) throw new Error(`Missing env ${k}`); return v; }
}
