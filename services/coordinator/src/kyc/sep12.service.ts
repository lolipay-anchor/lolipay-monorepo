import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KYC_FIELD_DESCRIPTORS } from './kyc-provider';

@Injectable()
export class Sep12Service {
  constructor(private prisma: PrismaService) {}

  async get(customerRef: string) {
    const row = await this.prisma.kycVerification.findUnique({ where: { customerRef } });
    if (!row) return { status: 'NEEDS_INFO', fields: KYC_FIELD_DESCRIPTORS };
    if (row.status === 'NEEDS_INFO') {
      return { id: row.customerRef, status: row.status, fields: KYC_FIELD_DESCRIPTORS };
    }
    return { id: row.customerRef, status: row.status };
  }
}
