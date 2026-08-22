import { ServiceUnavailableException } from '@nestjs/common';
import { PersonService } from './person.service';
import { UserReputationService } from '../reputation/user-reputation.service';

const ADDR = 'GNEVERSEEN';

function makePrisma() {
  const links = new Map<string, any>();
  const client: any = {
    person: { create: jest.fn(async () => ({ id: 'person-1' })) },
    walletLink: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const l = links.get(where.stellarAddress);
        if (!l) return null;
        return include?.person ? { ...l, person: { id: l.personId } } : l;
      }),
      findMany: jest.fn(async () => []),
      create: jest.fn(async ({ data }: any) => {
        links.set(data.stellarAddress, { status: 'ACTIVE', ...data });
        return data;
      }),
    },
    userProfile: { aggregate: jest.fn(async () => ({ _sum: { disputesLost: 0 } })) },
    order: { count: jest.fn(async () => 0), aggregate: jest.fn(async () => ({ _sum: { usdcAmount: null } })) },
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));
  return { client, links };
}

describe('only a signature may mint the row that authorises a session', () => {
  it('pricing an order never creates a wallet link for an address it has not seen', async () => {
    const { client } = makePrisma();
    const people = new PersonService(client);
    const reputation = new UserReputationService(client, people);

    await expect(reputation.personIdFor(ADDR)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client.walletLink.create).not.toHaveBeenCalled();
    expect(client.person.create).not.toHaveBeenCalled();
  });

  it('resolves the person once a signature has proven the wallet', async () => {
    const { client } = makePrisma();
    const people = new PersonService(client);
    const reputation = new UserReputationService(client, people);

    const proven = await people.proveWallet(ADDR, 'SEP53');

    await expect(reputation.personIdFor(ADDR)).resolves.toBe(proven.id);
  });

  it('refuses to resolve a person for a wallet whose link was revoked', async () => {
    const { client, links } = makePrisma();
    const people = new PersonService(client);
    const reputation = new UserReputationService(client, people);
    await people.proveWallet(ADDR, 'SEP53');
    links.set(ADDR, { ...links.get(ADDR), status: 'REVOKED' });

    await expect(reputation.personIdFor(ADDR)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
