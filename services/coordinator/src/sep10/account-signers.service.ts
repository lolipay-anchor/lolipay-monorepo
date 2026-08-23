import { Injectable } from '@nestjs/common';
import { MuxedAccount } from '@stellar/stellar-sdk';
import { AppConfigService } from '../config/app-config.service';

export const HORIZON_TIMEOUT_MS = 8000;

export interface AccountSigner {
  key: string;
  weight: number;
  type: string;
}

export interface AccountSigners {
  signers: AccountSigner[];
  medThreshold: number;
}

export function baseStellarAccount(address: string): string {
  if (!address.startsWith('M')) return address;
  return MuxedAccount.fromAddress(address, '0').baseAccount().accountId();
}

@Injectable()
export class AccountSignersService {
  private networkChecked = false;

  constructor(private cfg: AppConfigService) {}

  async load(address: string): Promise<AccountSigners | null> {
    await this.assertSameNetwork();
    const account = baseStellarAccount(address);
    const res = await this.get(`/accounts/${encodeURIComponent(account)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`horizon answered ${res.status} for ${account}`);

    const body = (await res.json()) as {
      signers?: AccountSigner[];
      thresholds?: { med_threshold?: number };
    };
    const medThreshold = body.thresholds?.med_threshold;
    if (!Number.isInteger(medThreshold)) {
      throw new Error(`horizon returned no medium threshold for ${account}`);
    }
    return { signers: body.signers ?? [], medThreshold: medThreshold as number };
  }

  private async assertSameNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const res = await this.get('/');
    if (!res.ok) throw new Error(`horizon answered ${res.status} when asked which network it is`);
    const body = (await res.json()) as { network_passphrase?: string };
    if (body.network_passphrase !== this.cfg.networkPassphrase) {
      throw new Error(
        'horizon is serving a different network than this anchor is configured for — ' +
          'every account would look absent and multisig verification would never run',
      );
    }
    this.networkChecked = true;
  }

  private get(path: string): Promise<Response> {
    const base = this.cfg.horizonUrl.replace(/\/+$/, '');
    return fetch(`${base}${path}`, { signal: AbortSignal.timeout(HORIZON_TIMEOUT_MS) });
  }
}
