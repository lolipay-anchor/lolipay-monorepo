import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../person/person.service';
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
    if (row.status === 'REJECTED') {
      return {
        id: row.customerRef,
        status: row.status,
        message: row.rejectionReason ?? 'this identity was refused',
      };
    }
    return { id: row.customerRef, status: row.status, provided_fields: PROVIDED };
  }

  async forget(customerRef: string): Promise<number> {
    const standing = await this.prisma.kycVerification.findUnique({ where: { customerRef } });
    if (!standing) return 0;
    if (standing.status === 'REJECTED') {
      if (standing.rejectionReason === null && standing.screenedAt === null) return 0;
      await this.prisma.kycVerification.update({
        where: { customerRef },
        data: { rejectionReason: null, screenedAt: null, verifiedAt: null },
      });
      return 1;
    }
    const { count } = await this.prisma.kycVerification.deleteMany({ where: { customerRef } });
    return count;
  }

  async put(customerRef: string, fields: Record<string, string>) {
    const person = await this.people.lookupPerson(customerRef);
    const refused = await this.prisma.kycVerification.findFirst({
      where: {
        status: 'REJECTED',
        OR: [{ customerRef }, ...(person ? [{ personId: person.id }] : [])],
      },
    });
    if (refused) {
      throw new ForbiddenException('this identity was refused and cannot be resubmitted here');
    }
    const decision = await this.provider.start(fields);
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
