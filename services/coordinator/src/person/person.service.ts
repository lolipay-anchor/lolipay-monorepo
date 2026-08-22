import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Person, WalletAuthMethod } from '../generated/prisma/client';

@Injectable()
export class PersonService {
  constructor(private prisma: PrismaService) {}

  async ensureForAddress(address: string, authMethod: WalletAuthMethod): Promise<Person> {
    const existing = await this.linkedPerson(address);
    if (existing) return existing;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const person = await tx.person.create({ data: {} });
        await tx.walletLink.create({
          data: { stellarAddress: address, personId: person.id, authMethod },
        });
        return person;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await this.linkedPerson(address);
      if (!raced) throw err;
      return raced;
    }
  }

  private async linkedPerson(address: string): Promise<Person | null> {
    const link = await this.prisma.walletLink.findUnique({
      where: { stellarAddress: address },
      include: { person: true },
    });
    return link ? link.person : null;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
