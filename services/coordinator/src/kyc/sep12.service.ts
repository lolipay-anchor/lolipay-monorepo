import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../person/person.service';
import { AppConfigService } from '../config/app-config.service';
import { DiditRefusalsService } from '../monitoring/didit-refusals.service';
import { DiditConclusion } from './didit-decision';

const DIDIT_DELIVERY_LOCK = 2;
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
    private cfg: AppConfigService,
    private refusals: DiditRefusalsService,
  ) {}

  private async recordIncomplete(customerRef: string, personId: string) {
    await this.prisma.kycVerification.upsert({
      where: { customerRef },
      create: { customerRef, personId, status: 'NEEDS_INFO' },
      update: { personId, status: 'NEEDS_INFO' },
    });
    return { id: customerRef };
  }

  async applyDelivery(conclusion: DiditConclusion, deliveredAt: Date): Promise<void> {
    const customerRef = conclusion.customerRef;
    if (typeof customerRef !== 'string' || customerRef.length === 0) {
      return this.refusals.record('a delivery named no customer this anchor can read');
    }
    if (conclusion.unrecognisedStatus !== undefined) {
      return this.refusals.record('a delivery reported a status this anchor does not recognise');
    }
    if (conclusion.environment !== this.cfg.diditEnvironment) {
      return this.refusals.record('a delivery came from an environment this deployment is not configured for');
    }

    const person = await this.people.lookupPerson(customerRef);
    if (!person) return;

    const refusing = conclusion.status === 'REJECTED';

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DIDIT_DELIVERY_LOCK}, hashtext(${person.id}))`;

      const elsewhere = await tx.kycVerification.findFirst({
        where: { status: 'REJECTED', personId: person.id, NOT: { customerRef } },
      });
      if (elsewhere && !refusing) return;

      const standing = await tx.kycVerification.findUnique({ where: { customerRef } });
      if (standing) {
        if (standing.status === 'REJECTED') return;
        if (
          !refusing &&
          standing.status === 'ACCEPTED' &&
          standing.providerRef &&
          standing.providerRef !== conclusion.providerRef
        ) {
          this.refusals.record('a delivery named a session this customer is not following');
          return;
        }
        if (!refusing && standing.deliveredAt && standing.deliveredAt > deliveredAt) return;
      }
      await this.writeDelivery(tx, customerRef, person.id, conclusion, deliveredAt, standing);
      this.refusals.applied();
    });
  }

  private async writeDelivery(
    tx: any,
    customerRef: string,
    personId: string,
    conclusion: DiditConclusion,
    deliveredAt: Date,
    standing: unknown,
  ): Promise<void> {
    const person = { id: personId };
    const screened = conclusion.screened;
    const state = {
      personId: person.id,
      status: conclusion.status,
      providerRef: conclusion.providerRef ?? null,
      environment: conclusion.environment ?? null,
      rejectionReason: conclusion.rejectionReason ?? null,
      deliveredAt,
      screenedAt: screened ? deliveredAt : null,
      verifiedAt: conclusion.status === 'ACCEPTED' ? deliveredAt : null,
    };

    if (standing) {
      await tx.kycVerification.update({ where: { customerRef }, data: state });
    } else {
      await tx.kycVerification.create({ data: { customerRef, ...state } });
    }
  }

  private async standingRefusal(customerRef: string) {
    const person = await this.people.lookupPerson(customerRef);
    if (!person) return null;
    return this.prisma.kycVerification.findFirst({
      where: { status: 'REJECTED', OR: [{ customerRef }, { personId: person.id }] },
    });
  }

  async get(customerRef: string) {
    const row = await this.prisma.kycVerification.findUnique({ where: { customerRef } });
    if (!row) {
      const refusal = await this.standingRefusal(customerRef);
      if (refusal) {
        return {
          id: refusal.customerRef,
          status: refusal.status,
          message: refusal.rejectionReason ?? 'this identity was refused',
        };
      }
      return { status: 'NEEDS_INFO', fields: KYC_FIELD_DESCRIPTORS };
    }
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
    if (!standing) return (await this.standingRefusal(customerRef)) ? 1 : 0;
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
    if (!person) {
      throw new ForbiddenException('this wallet is no longer permitted to register a customer');
    }
    const refused = await this.prisma.kycVerification.findFirst({
      where: { status: 'REJECTED', OR: [{ customerRef }, { personId: person.id }] },
    });
    if (refused) {
      throw new ForbiddenException('this identity was refused and cannot be resubmitted here');
    }
    if (REQUIRED_KYC_FIELDS.some((f) => !fields[f]?.trim())) {
      return this.recordIncomplete(customerRef, person.id);
    }

    const inFlight = await this.prisma.kycVerification.findUnique({ where: { customerRef } });
    if (inFlight?.status === 'PROCESSING' && inFlight.providerRef) {
      return { id: customerRef };
    }

    const decision = await this.provider.start(customerRef, fields);
    const state = {
      personId: person?.id ?? null,
      status: decision.status,
      providerRef: decision.providerRef ?? null,
      rejectionReason: decision.rejectionReason ?? null,
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
