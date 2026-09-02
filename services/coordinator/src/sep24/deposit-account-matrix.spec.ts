import { Account, Keypair, MuxedAccount } from '@stellar/stellar-sdk';
import { Sep24Service } from './sep24.service';

const A = Keypair.random().publicKey();
const B = Keypair.random().publicKey();
const muxed = (g: string, id: string) => new MuxedAccount(new Account(g, '0'), id).accountId();
const CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

function service() {
  const prisma: any = {
    sep24Transaction: { create: async () => ({ id: 'tx-1' }) },
  };
  const cfg: any = { usdcAssetCode: 'USDC', anchorBaseUrl: 'https://api.test', jwtSecret: 'x', jwtIssuer: 'y' };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  return new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, {} as any);
}

const opens = async (subject: string, account: string) => {
  try {
    await (service() as any).openInteractive(subject, 'person-1', { asset_code: 'USDC', account });
    return true;
  } catch (err: any) {
    if (/will not deposit to another|is not a Stellar address/.test(err.message)) return false;
    throw err;
  }
};

describe('which account a deposit may name, against where the escrow would credit it', () => {
  it.each([
    ['the bare account a bare token speaks for', A, A],
    ['a sibling memo of the same account', `${A}:1`, `${A}:2`],
    ['the base account a muxed token speaks for', muxed(A, '1'), A],
    ['a muxed of the account a bare token speaks for', A, muxed(A, '1')],
    ['a sibling muxed of the same base', muxed(A, '1'), muxed(A, '2')],
    ['a muxed of the account a memo token speaks for', `${A}:1`, muxed(A, '9')],
  ])('accepts %s, because the escrow credits the same account either way', async (_n, subject, account) => {
    await expect(opens(subject, account)).resolves.toBe(true);
  });

  it.each([
    ['a stranger', A, B],
    ['a muxed of a different holder', muxed(A, '1'), muxed(B, '1')],
    ['the bare account of a different holder', muxed(A, '1'), B],
    ['a muxed of a different holder, from a bare token', A, muxed(B, '1')],
    ['a stranger under a memo', `${A}:1`, `${B}:1`],
    ['a contract, which no token can ever speak for', A, CONTRACT],
  ])('refuses %s, which the escrow would never credit', async (_n, subject, account) => {
    await expect(opens(subject, account)).resolves.toBe(false);
  });

  it('refuses a value that is not a Stellar address at all', async () => {
    for (const bad of ['', ':' + A, A.toLowerCase(), 'not-an-address']) {
      await expect(opens(A, bad)).resolves.toBe(false);
    }
  });
});
