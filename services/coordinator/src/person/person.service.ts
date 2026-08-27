import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { baseStellarAccount } from '../sep10/account-signers.service';
import { randomBytes } from 'crypto';
import { verifySep53 } from '../auth/sep53';
import { PrismaService } from '../prisma/prisma.service';
import { Person, WalletAuthMethod, WalletLink } from '../generated/prisma/client';

export type PersonId = string & { readonly __brand: 'PersonId' };

export const WALLET_CAP = 5;
export const LINK_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LINK_PREFIX = 'lolipay-wallet-link';

export type LinkProof = { challenge: string; signature: string };

@Injectable()
export class PersonService {
  constructor(private prisma: PrismaService) {}

  async proveWallet(address: string, authMethod: WalletAuthMethod): Promise<Person> {
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

  async lookupPerson(subject: string): Promise<Person | null> {
    const link = await this.prisma.walletLink.findUnique({
      where: { stellarAddress: baseStellarAccount(subject.split(':')[0]) },
      include: { person: true },
    });
    if (!link || link.status !== 'ACTIVE') return null;
    return link.person;
  }

  async walletsOf(personId: PersonId): Promise<string[]> {
    const links = await this.prisma.walletLink.findMany({
      where: { personId },
      select: { stellarAddress: true },
    });
    return links.map((l) => l.stellarAddress);
  }

  private async requirePersonId(callerAddress: string): Promise<string> {
    const person = await this.lookupPerson(callerAddress);
    if (!person) throw new UnauthorizedException('caller has no proven wallet');
    return person.id;
  }

  async issueLinkChallenge(callerAddress: string, address: string): Promise<string> {
    const personId = await this.requirePersonId(callerAddress);
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
    await this.prisma.walletLinkChallenge.create({
      data: { nonce, personId, stellarAddress: address, expiresAt, consumedAt: null },
    });
    return `${LINK_PREFIX}:${address}:${nonce}:${expiresAt.getTime()}`;
  }

  async linkWallet(callerAddress: string, address: string, proof: LinkProof): Promise<WalletLink> {
    const personId = await this.requirePersonId(callerAddress);
    const parts = proof.challenge.split(':');
    if (parts.length !== 4 || parts[0] !== LINK_PREFIX || parts[1] !== address) {
      throw new UnauthorizedException('link challenge does not belong to this address');
    }
    if (!verifySep53(address, proof.challenge, proof.signature)) {
      throw new UnauthorizedException('link proof is not signed by the address');
    }

    const issued = await this.prisma.walletLinkChallenge.findUnique({
      where: { nonce: parts[2] },
    });
    if (
      !issued ||
      issued.consumedAt !== null ||
      issued.personId !== personId ||
      issued.stellarAddress !== address ||
      issued.expiresAt.getTime() <= Date.now()
    ) {
      throw new UnauthorizedException('link challenge is unknown, spent or expired');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${personId}))`;

        const existing = await tx.walletLink.findUnique({
          where: { stellarAddress: address },
        });
        if (existing && existing.personId !== personId) {
          throw new ConflictException('address is already linked to another person');
        }
        if (!existing || existing.status === 'REVOKED') {
          const active = await tx.walletLink.count({
            where: { personId, status: 'ACTIVE' },
          });
          if (active >= WALLET_CAP) {
            throw new ConflictException(`a person may hold at most ${WALLET_CAP} active wallets`);
          }
        }

        const spent = await tx.walletLinkChallenge.updateMany({
          where: { nonce: parts[2], consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (spent.count !== 1) {
          throw new UnauthorizedException('link challenge is unknown, spent or expired');
        }

        if (existing) {
          return tx.walletLink.update({
            where: { stellarAddress: address },
            data: { status: 'ACTIVE', authMethod: 'SEP53', provenAt: new Date() },
          });
        }
        return tx.walletLink.create({
          data: { stellarAddress: address, personId, authMethod: 'SEP53' },
        });
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException('address is already linked to another person');
      }
      throw err;
    }
  }

  async revokeWallet(callerAddress: string, address: string): Promise<void> {
    const personId = await this.requirePersonId(callerAddress);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${personId}))`;
      const active = await tx.walletLink.count({
        where: { personId, status: 'ACTIVE' },
      });
      if (active <= 1) {
        throw new ConflictException('a person must keep at least one active wallet');
      }
      const revoked = await tx.walletLink.updateMany({
        where: { stellarAddress: address, personId, status: 'ACTIVE' },
        data: { status: 'REVOKED' },
      });
      if (revoked.count !== 1) {
        throw new ConflictException('no active link between this person and this address');
      }
    });
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
