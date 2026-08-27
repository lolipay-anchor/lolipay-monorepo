import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../person/person.service';
import { baseStellarAccount } from '../sep10/account-signers.service';
import {
  KYC_FIELD_DESCRIPTORS,
  KYC_PROVIDER,
  KycProvider,
  REQUIRED_KYC_FIELDS,
} from './kyc-provider';

const PROVIDED = Object.fromEntries(
  REQUIRED_KYC_FIELDS.map((f) => [f, KYC_FIELD_DESCRIPTORS[f]]),
);

@Injectable()
export class Sep12Service {
  constructor(
    private prisma: PrismaService,
    private people: PersonService,
    @Inject(KYC_PROVIDER) private provider: KycProvider,
  ) {}

  async get(customerRef: string) {
    const row = await this.prisma.kycVerification.findUnique({ where: { customerRef } });
    if (!row) return { status: 'NEEDS_INFO', fields: KYC_FIELD_DESCRIPTORS };
    if (row.status === 'NEEDS_INFO') {
      return { id: row.customerRef, status: row.status, fields: KYC_FIELD_DESCRIPTORS };
    }
    return { id: row.customerRef, status: row.status, provided_fields: PROVIDED };
  }

  async put(customerRef: string, fields: Record<string, string>) {
    const decision = await this.provider.start(fields);
    const person = await this.people.lookupPerson(baseStellarAccount(customerRef.split(':')[0]));
    const state = {
      personId: person?.id ?? null,
      status: decision.status,
      providerRef: decision.providerRef ?? null,
      rejectionReason: decision.rejectionReason ?? null,
      screenedAt: decision.screened ? new Date() : null,
      verifiedAt: decision.status === 'ACCEPTED' ? new Date() : null,
    };
    await this.prisma.kycVerification.upsert({
      where: { customerRef },
      create: { customerRef, ...state },
      update: state,
    });
    return { id: customerRef };
  }
}
