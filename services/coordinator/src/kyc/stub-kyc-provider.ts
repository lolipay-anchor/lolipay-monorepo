import { Injectable } from '@nestjs/common';
import { KycDecision, KycProvider, REQUIRED_KYC_FIELDS } from './kyc-provider';

@Injectable()
export class StubKycProvider implements KycProvider {
  async start(fields: Record<string, string>): Promise<KycDecision> {
    if (REQUIRED_KYC_FIELDS.some((f) => !fields[f]?.trim())) {
      return { status: 'NEEDS_INFO', screened: false };
    }
    if (fields.first_name.trim().toUpperCase() === 'REJECT') {
      return {
        status: 'REJECTED',
        screened: false,
        rejectionReason: 'the operator marked this identity as refused',
      };
    }
    return { status: 'ACCEPTED', screened: true };
  }
}
