import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LpService } from './lp.service';

const LP_ADDR = 'GLPWALLET';

function makePrisma(overrides: Partial<Record<string, any>> = {}) {
  return {
    lp: {
      findUnique: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP_ADDR }),
    },
    paymentMethod: {
      create: jest.fn().mockResolvedValue({ id: 'pm1' }),
      findFirst: jest.fn().mockResolvedValue({ id: 'pm1', lpId: 'lp1', details: 'BCA 555555' }),
      update: jest.fn().mockResolvedValue({ id: 'pm1' }),
    },
    ...overrides,
  } as any;
}

function makeSvc(prisma: any) {
  return new LpService(prisma, {} as any);
}

const DANGEROUS_CODE_POINTS: Array<[string, string]> = [
  ['U+200B ZERO WIDTH SPACE', String.fromCodePoint(0x200b)],
  ['U+200E LEFT-TO-RIGHT MARK', String.fromCodePoint(0x200e)],
  ['U+202E RIGHT-TO-LEFT OVERRIDE', String.fromCodePoint(0x202e)],
  ['U+00AD SOFT HYPHEN', String.fromCodePoint(0x00ad)],
  ['U+0000 NULL', String.fromCodePoint(0x0000)],
  ['U+0007 BELL', String.fromCodePoint(0x0007)],
  ['U+001B ESCAPE', String.fromCodePoint(0x001b)],
  ['U+2028 LINE SEPARATOR', String.fromCodePoint(0x2028)],
  ['U+2029 PARAGRAPH SEPARATOR', String.fromCodePoint(0x2029)],
  ['U+D800 LONE SURROGATE', String.fromCharCode(0xd800)],
];

describe('LpService.addPaymentMethod refuses the same destinations the depositor-facing column refuses', () => {
  it.each(DANGEROUS_CODE_POINTS)('refuses a destination carrying %s', async (_label, codePoint) => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(
      svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', `BCA 123${codePoint}456`),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only destination', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', '      ')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it('refuses fewer than six word characters', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', 'BCA 1')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it('does not count punctuation toward the six-word-character floor', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', '------')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.paymentMethod.create).not.toHaveBeenCalled();
  });

  it.each(['BNI 999', 'BCA 001', 'BCA 123'])(
    'accepts %s, an existing e2e fixture with exactly six word characters',
    async (details) => {
      const prisma = makePrisma();
      const svc = makeSvc(prisma);

      await svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', details);

      expect(prisma.paymentMethod.create).toHaveBeenCalledWith({
        data: { lpId: 'lp1', rail: 'BANK', label: 'BCA', details },
      });
    },
  );

  it('trims the destination before storing it', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await svc.addPaymentMethod(LP_ADDR, 'BANK' as any, 'BCA', '  BCA 555555  ');

    expect(prisma.paymentMethod.create).toHaveBeenCalledWith({
      data: { lpId: 'lp1', rail: 'BANK', label: 'BCA', details: 'BCA 555555' },
    });
  });
});

describe('LpService.updatePaymentMethod applies the same rule ONLY when details is patched', () => {
  it.each(DANGEROUS_CODE_POINTS.slice(0, 3))('refuses a patched destination carrying %s', async (_label, codePoint) => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(
      svc.updatePaymentMethod(LP_ADDR, 'pm1', { details: `BCA 123${codePoint}456` }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.paymentMethod.update).not.toHaveBeenCalled();
  });

  it('refuses a patched destination shorter than six word characters', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await expect(svc.updatePaymentMethod(LP_ADDR, 'pm1', { details: 'BCA 1' })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.paymentMethod.update).not.toHaveBeenCalled();
  });

  it('trims a patched destination before storing it', async () => {
    const prisma = makePrisma();
    const svc = makeSvc(prisma);

    await svc.updatePaymentMethod(LP_ADDR, 'pm1', { details: '  BCA 555555  ' });

    expect(prisma.paymentMethod.update).toHaveBeenCalledWith({
      where: { id: 'pm1' },
      data: { details: 'BCA 555555' },
    });
  });

  it('does not validate the existing details at all when a patch omits it, so a row written under an older rule stays editable', async () => {
    const prisma = makePrisma({
      paymentMethod: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'pm1',
          lpId: 'lp1',
          details: String.fromCodePoint(0x202e).repeat(6),
        }),
        update: jest.fn().mockResolvedValue({ id: 'pm1' }),
      },
    });
    const svc = makeSvc(prisma);

    await svc.updatePaymentMethod(LP_ADDR, 'pm1', { active: true });

    expect(prisma.paymentMethod.update).toHaveBeenCalledWith({
      where: { id: 'pm1' },
      data: { active: true },
    });
    const call = (prisma.paymentMethod.update as jest.Mock).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('details');
  });

  it('throws NotFoundException before validating, when the payment method does not belong to this provider', async () => {
    const prisma = makePrisma({
      paymentMethod: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    });
    const svc = makeSvc(prisma);

    await expect(
      svc.updatePaymentMethod(LP_ADDR, 'pm1', { details: String.fromCodePoint(0x202e).repeat(6) }),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.paymentMethod.update).not.toHaveBeenCalled();
  });
});
