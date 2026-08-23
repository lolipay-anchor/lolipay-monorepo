import {
  BadRequestException,
  Injectable,
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

  constructor(private cfg: AppConfigService) {
    this.signer = loadSigner(cfg.sep10SigningKey);
    requireBareHost('ANCHOR_HOME_DOMAIN', cfg.anchorHomeDomain);
    requireBareHost('SEP10_WEB_AUTH_DOMAIN', cfg.sep10WebAuthDomain);
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
      this.cfg.anchorHomeDomain,
      CHALLENGE_TIMEOUT_SECONDS,
      this.cfg.networkPassphrase,
      this.cfg.sep10WebAuthDomain,
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
    return this.signer !== null;
  }

  private requireSigner(): Keypair {
    if (!this.signer) {
      throw new ServiceUnavailableException('this anchor has no SEP-10 signing key configured');
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

function requireBareHost(name: string, value: string): void {
  if (value !== value.trim() || /[/\\]|:\/\//.test(value) || value === '') {
    throw new Error(`${name} must be a bare host such as lolipay.app, with no scheme or path`);
  }
}
