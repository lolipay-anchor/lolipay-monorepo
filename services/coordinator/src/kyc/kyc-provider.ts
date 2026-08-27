export type KycStatus = 'NEEDS_INFO' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED';

export interface KycDecision {
  status: KycStatus;
  screened: boolean;
  rejectionReason?: string;
  providerRef?: string;
}

export interface KycProvider {
  start(fields: Record<string, string>): Promise<KycDecision>;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

export const REQUIRED_KYC_FIELDS = [
  'first_name',
  'last_name',
  'email_address',
  'id_type',
  'id_country_code',
] as const;

export const KYC_FIELD_DESCRIPTORS: Record<string, { type: string; description: string }> = {
  first_name: { type: 'string', description: 'given name as it appears on the identity document' },
  last_name: { type: 'string', description: 'family name as it appears on the identity document' },
  email_address: { type: 'string', description: 'an address that can receive verification mail' },
  id_type: { type: 'string', description: 'the kind of identity document being presented' },
  id_country_code: { type: 'string', description: 'ISO 3166-1 alpha-3 code of the issuing country' },
};
