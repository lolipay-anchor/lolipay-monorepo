import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { verifySep53 } from '../auth/sep53';
import { PrismaService } from '../prisma/prisma.service';
import { Person, WalletAuthMethod, WalletLink } from '../generated/prisma/client';

export const WALLET_CAP = 5;
export const LINK_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LINK_PREFIX = 'lolipay-wallet-link';

export type LinkProof = { challenge: string; signature: string };

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

  async issueLinkChallenge(personId: string, address: string): Promise<string> {
    const nonce = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + LINK_CHALLENGE_TTL_MS);
    await this.prisma.walletLinkChallenge.create({
      data: { nonce, personId, stellarAddress: address, expiresAt, consumedAt: null },
    });
    return `${LINK_PREFIX}:${address}:${nonce}:${expiresAt.getTime()}`;
  }

  async linkWallet(personId: string, address: string, proof: LinkProof): Promise<WalletLink> {
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

    const existing = await this.prisma.walletLink.findUnique({
      where: { stellarAddress: address },
    });
    if (existing && existing.personId !== personId) {
      throw new ConflictException('address is already linked to another person');
    }
    if (!existing || existing.status === 'REVOKED') {
      const active = await this.prisma.walletLink.count({
        where: { personId, status: 'ACTIVE' },
      });
      if (active >= WALLET_CAP) {
        throw new ConflictException(`a person may hold at most ${WALLET_CAP} active wallets`);
      }
    }

    const spent = await this.prisma.walletLinkChallenge.updateMany({
      where: { nonce: parts[2], consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count !== 1) {
      throw new UnauthorizedException('link challenge is unknown, spent or expired');
    }

    if (existing) {
      return this.prisma.walletLink.update({
        where: { stellarAddress: address },
        data: { status: 'ACTIVE', authMethod: 'SEP53', provenAt: new Date() },
      });
    }
    return this.prisma.walletLink.create({
      data: { stellarAddress: address, personId, authMethod: 'SEP53' },
    });
  }

  async revokeWallet(personId: string, address: string): Promise<void> {
    const active = await this.prisma.walletLink.count({
      where: { personId, status: 'ACTIVE' },
    });
    if (active <= 1) {
      throw new ConflictException('a person must keep at least one active wallet');
    }
    const revoked = await this.prisma.walletLink.updateMany({
      where: { stellarAddress: address, personId, status: 'ACTIVE' },
      data: { status: 'REVOKED' },
    });
    if (revoked.count !== 1) {
      throw new ConflictException('no active link between this person and this address');
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
