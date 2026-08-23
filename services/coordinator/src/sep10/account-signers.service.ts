import { Injectable } from '@nestjs/common';
import { MuxedAccount } from '@stellar/stellar-sdk';
import { AppConfigService } from '../config/app-config.service';

export interface AccountSigner {
  key: string;
  weight: number;
  type: string;
}

export interface AccountSigners {
  signers: AccountSigner[];
  medThreshold: number;
}

@Injectable()
export class AccountSignersService {
  constructor(private cfg: AppConfigService) {}

  async load(address: string): Promise<AccountSigners | null> {
    const account = baseAccount(address);
    const res = await fetch(`${this.cfg.horizonUrl}/accounts/${account}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`horizon answered ${res.status} for ${account}`);
    }
    const body = (await res.json()) as {
      signers?: AccountSigner[];
      thresholds?: { med_threshold?: number };
    };
    return {
      signers: body.signers ?? [],
      medThreshold: body.thresholds?.med_threshold ?? 0,
    };
  }
}

function baseAccount(address: string): string {
  if (!address.startsWith('M')) return address;
  return MuxedAccount.fromAddress(address, '0').baseAccount().accountId();
}
