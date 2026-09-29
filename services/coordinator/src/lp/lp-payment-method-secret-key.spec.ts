import {
  LpService,
  PAYMENT_METHOD_SECRET_KEY_MESSAGE,
  PAYMENT_METHOD_TOO_SHORT_MESSAGE,
} from './lp.service';

const LP_ADDR = 'GLPWALLET';

const seedShape = (body = 'A') => `S${body.repeat(Math.ceil(55 / body.length)).slice(0, 55)}`;

function makePrisma() {
  return {
    lp: {
      findUnique: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP_ADDR }),
    },
    paymentMethod: {
      create: jest.fn().mockResolvedValue({ id: 'pm1' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'pm1', lpId: 'lp1', details: 'BCA 555555' }),
      update: jest.fn().mockResolvedValue({ id: 'pm1' }),
    },
  } as any;
}

const SEED_FIXTURES: Array<[string, string]> = [
  ['the seed on its own', seedShape()],
  ['a word before it', `BCA ${seedShape()}`],
  ['no separator at all', `BCA123${seedShape()}`],
  ['entirely lowercase', `s${'a'.repeat(55)}`],
];

describe('a provider who pastes a Stellar secret key into payment details is told what it is, not told to enter more of it', () => {
  it('the fixture is the 56-character shape a wallet export produces', () => {
    expect(seedShape()).toHaveLength(56);
  });

  it.each(SEED_FIXTURES)('addPaymentMethod refuses %s with the secret-key message', async (_label, details) => {
    const prisma = makePrisma();
    const svc = new LpService(prisma, {} as any);

    await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', details)).rejects.toThrow(
      PAYMENT_METHOD_SECRET_KEY_MESSAGE,
    );
    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it.each(SEED_FIXTURES)(
    'addPaymentMethod does NOT tell a provider who pasted %s to enter the full destination, which is what the unwired dispatch did',
    async (_label, details) => {
      const prisma = makePrisma();
      const svc = new LpService(prisma, {} as any);

      await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', details)).rejects.not.toThrow(
        PAYMENT_METHOD_TOO_SHORT_MESSAGE,
      );
    },
  );

  it.each(SEED_FIXTURES)('updatePaymentMethod refuses %s with the secret-key message', async (_label, details) => {
    const prisma = makePrisma();
    const svc = new LpService(prisma, {} as any);

    await expect(svc.updatePaymentMethod(LP_ADDR, 'pm1', { details })).rejects.toThrow(
      PAYMENT_METHOD_SECRET_KEY_MESSAGE,
    );
    expect(prisma.paymentMethod.update).not.toHaveBeenCalled();
  });

  it.each(SEED_FIXTURES)(
    'updatePaymentMethod does NOT tell a provider who pasted %s to enter the full destination',
    async (_label, details) => {
      const prisma = makePrisma();
      const svc = new LpService(prisma, {} as any);

      await expect(svc.updatePaymentMethod(LP_ADDR, 'pm1', { details })).rejects.not.toThrow(
        PAYMENT_METHOD_TOO_SHORT_MESSAGE,
      );
    },
  );

  it('a destination that really is too short still gets the too-short message, so the branch above is not swallowing everything', async () => {
    const prisma = makePrisma();
    const svc = new LpService(prisma, {} as any);

    await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', 'BCA 1')).rejects.toThrow(
      PAYMENT_METHOD_TOO_SHORT_MESSAGE,
    );
  });

  it('a real bank destination is still accepted and still persisted', async () => {
    const prisma = makePrisma();
    const svc = new LpService(prisma, {} as any);

    await svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', 'BCA 1234567890 SIGIT PRAYOGO');

    expect(prisma.paymentMethod.create).toHaveBeenCalledWith({
      data: { lpId: 'lp1', rail: 'BANK', label: 'BCA', details: 'BCA 1234567890 SIGIT PRAYOGO' },
    });
  });
});

describe('the provider message names a payment destination rather than a bank account, because a payment method may be QRIS or EWALLET', () => {
  it('does not call the destination a bank account, which is false on two of the three rails', () => {
    expect(PAYMENT_METHOD_SECRET_KEY_MESSAGE).not.toMatch(/bank account/i);
  });

  it('still warns that the key is compromised and must be rotated', () => {
    expect(PAYMENT_METHOD_SECRET_KEY_MESSAGE).toMatch(/new wallet/i);
  });
});
