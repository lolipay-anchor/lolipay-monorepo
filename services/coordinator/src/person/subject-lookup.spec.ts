import { PersonService } from './person.service';

const G = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const M = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';

function serviceOver(linkedAt: string) {
  const prisma = {
    walletLink: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.stellarAddress === linkedAt
          ? { status: 'ACTIVE', person: { id: 'person-1' } }
          : null,
      ),
    },
  } as any;
  return { svc: new PersonService(prisma), prisma };
}

describe('a wallet link is keyed on the account that was proven, never on the subject', () => {
  it.each([
    ['a plain subject', G],
    ['a subject carrying a memo', `${G}:1234`],
  ])('finds the person behind %s', async (_name, sub) => {
    const { svc, prisma } = serviceOver(G);
    await expect(svc.lookupPerson(sub)).resolves.toEqual({ id: 'person-1' });
    expect(prisma.walletLink.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stellarAddress: G } }),
    );
  });

  it('finds the person behind a muxed subject', async () => {
    const { svc } = serviceOver(G);
    await expect(svc.lookupPerson(M)).resolves.toEqual({ id: 'person-1' });
  });

  it('still finds nobody when the underlying account was never proven', async () => {
    const { svc } = serviceOver('GSOMEONEELSE');
    await expect(svc.lookupPerson(`${G}:1234`)).resolves.toBeNull();
  });
});
