import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ConsumedChallengeService {
  constructor(private prisma: PrismaService) {}

  async consume(nonce: string, expiresAt: Date): Promise<boolean> {
    try {
      await this.prisma.sep10ConsumedChallenge.create({ data: { nonce, expiresAt } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
