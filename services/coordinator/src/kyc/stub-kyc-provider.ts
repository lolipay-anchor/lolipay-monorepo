import { Injectable } from '@nestjs/common';
import { KycDecision, KycProvider, REQUIRED_KYC_FIELDS } from './kyc-provider';

@Injectable()
export class StubKycProvider implements KycProvider {
  async start(_customerRef: string, fields: Record<string, string>): Promise<KycDecision> {
    if (REQUIRED_KYC_FIELDS.some((f) => !fields[f]?.trim())) {
      return { status: 'NEEDS_INFO' };
    }
    if (fields.first_name.trim().toUpperCase() === 'REJECT') {
      return {
        status: 'REJECTED',
        rejectionReason: 'the operator marked this identity as refused',
      };
    }
    return { status: 'ACCEPTED' };
  }
}
