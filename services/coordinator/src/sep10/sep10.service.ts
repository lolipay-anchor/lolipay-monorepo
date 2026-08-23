import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Keypair, StrKey, WebAuth } from '@stellar/stellar-sdk';
import { AppConfigService } from '../config/app-config.service';

export const CHALLENGE_TIMEOUT_SECONDS = 900;
const MAX_MEMO_ID = 18446744073709551615n;

export interface ChallengeOptions {
  memo?: string;
  clientDomain?: string;
  clientSigningKey?: string;
}

export interface Challenge {
  transaction: string;
  network_passphrase: string;
}

@Injectable()
export class Sep10Service {
  private readonly signer: Keypair | null;

  private readonly log = new Logger(Sep10Service.name);

  constructor(private cfg: AppConfigService) {
    this.signer = loadSigner(cfg.sep10SigningKey);
    requireBareHost('ANCHOR_HOME_DOMAIN', cfg.anchorHomeDomain);
    requireBareHost('SEP10_WEB_AUTH_DOMAIN', cfg.sep10WebAuthDomain);
    if (!this.isConfigured) {
      this.log.warn(
        'SEP-10 is not configured — GET /auth will answer 503. Set SEP10_SIGNING_KEY, ' +
          'ANCHOR_HOME_DOMAIN and SEP10_WEB_AUTH_DOMAIN to serve the anchor.',
      );
    }
  }

  buildChallenge(account: string, options: ChallengeOptions): Challenge {
    const signer = this.requireSigner();
    const muxed = StrKey.isValidMed25519PublicKey(account);
    if (!muxed && !StrKey.isValidEd25519PublicKey(account)) {
      throw new BadRequestException('account must be a Stellar address');
    }
    if (options.memo !== undefined) {
      if (muxed) {
        throw new BadRequestException('memo may not be used with a muxed account');
      }
      if (!/^[0-9]+$/.test(options.memo) || BigInt(options.memo) > MAX_MEMO_ID) {
        throw new BadRequestException('memo must be a 64-bit unsigned integer');
      }
    }
    const transaction = WebAuth.buildChallengeTx(
      signer,
      account,
      this.cfg.anchorHomeDomain as string,
      CHALLENGE_TIMEOUT_SECONDS,
      this.cfg.networkPassphrase,
      this.cfg.sep10WebAuthDomain as string,
      options.memo ?? null,
      options.clientDomain ?? null,
      options.clientSigningKey ?? null,
    );

    return { transaction, network_passphrase: this.cfg.networkPassphrase };
  }

  get signingKey(): string {
    return this.requireSigner().publicKey();
  }

  get isConfigured(): boolean {
    return this.signer !== null && !!this.cfg.anchorHomeDomain && !!this.cfg.sep10WebAuthDomain;
  }

  private requireSigner(): Keypair {
    if (!this.isConfigured || !this.signer) {
      throw new ServiceUnavailableException('this anchor is not configured for SEP-10');
    }
    return this.signer;
  }
}

function loadSigner(seed: string | undefined): Keypair | null {
  if (seed === undefined || seed === '') return null;
  if (!StrKey.isValidEd25519SecretSeed(seed)) {
    throw new Error(
      'SEP10_SIGNING_KEY is set but is not a Stellar secret seed — refusing to start rather ' +
        'than serving an anchor that cannot sign a challenge',
    );
  }
  return Keypair.fromSecret(seed);
}

const MAX_DATA_KEY_LENGTH = 64;
const AUTH_KEY_SUFFIX = ' auth';

function requireBareHost(name: string, value: string | undefined): void {
  if (value === undefined || value === '') return;
  let parsed: URL;
  try {
    parsed = new URL(`https://${value}`);
  } catch {
    throw new Error(`${name} must be a bare host such as lolipay.app, with no scheme or path`);
  }
  const canonical = parsed.host;
  if (
    canonical !== value ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    value.length + AUTH_KEY_SUFFIX.length > MAX_DATA_KEY_LENGTH
  ) {
    throw new Error(
      `${name} must be a bare host such as lolipay.app, with no scheme or path, and short ` +
        `enough that "<host> auth" fits in ${MAX_DATA_KEY_LENGTH} characters`,
    );
  }
}
