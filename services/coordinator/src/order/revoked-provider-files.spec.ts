import { orderProofFor } from './test-helpers';

const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const ADMIN_ADDR = 'GADMIN';
const CONTRACT = 'CREVOKEDFILES';

function makeOrder(lpStatus: string, overrides: Record<string, unknown> = {}): any {
  return {
    id: 'order-1',
    userAddress: USER_ADDR,
    flow: 'WITHDRAW',
    status: 'DISPUTED',
    disputeAt: new Date('2026-09-01T00:00:00Z'),
    proofUrl: 'proofs/order-1.jpg',
    disputeEvidenceUrl: 'evidence/order-1.png',
    lp: { id: 'lp-1', stellarAddress: LP_ADDR, status: lpStatus },
    ...overrides,
  };
}

function build(lpStatus: string, adminAddresses: string[] = [], overrides: Record<string, unknown> = {}) {
  const order = makeOrder(lpStatus, overrides);
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
  } as any;
  const cfg = { escrowContractId: CONTRACT, adminAddresses } as any;
  return orderProofFor(prisma, {} as any, cfg, {} as any);
}

describe('a provider whose approval was withdrawn stops receiving the order files', () => {
  it.each([['REVOKED'], ['SUSPENDED']])(
    'refuses the payment proof to a %s provider',
    async (lpStatus) => {
      const proofs = build(lpStatus);

      await expect(proofs.getProofFile('order-1', LP_ADDR)).rejects.toThrow(
        'not authorized to view this order’s payment proof',
      );
    },
  );

  it.each([['REVOKED'], ['SUSPENDED']])(
    'still serves the dispute evidence to a %s provider, because they are party to the dispute and their stake is still slashable over it',
    async (lpStatus) => {
      const proofs = build(lpStatus);

      await expect(proofs.getDisputeEvidenceFile('order-1', LP_ADDR)).resolves.toEqual({
        key: 'evidence/order-1.png',
        contentType: 'image/png',
        ext: 'png',
      });
    },
  );

  it.each([['REVOKED'], ['SUSPENDED']])(
    'refuses the dispute evidence to a %s provider on an order carrying no dispute at all',
    async (lpStatus) => {
      const proofs = build(lpStatus, [], { status: 'FIAT_PAID', disputeAt: null });

      await expect(proofs.getDisputeEvidenceFile('order-1', LP_ADDR)).rejects.toThrow(
        'not authorized to view this order’s dispute evidence',
      );
    },
  );

  it('serves a stood-down provider a settled order whose post-settlement dispute was raised after release', async () => {
    const proofs = build('REVOKED', [], { status: 'RELEASED' });

    await expect(proofs.getDisputeEvidenceFile('order-1', LP_ADDR)).resolves.toMatchObject({
      key: 'evidence/order-1.png',
    });
  });

  it('still refuses the payment proof to a stood-down provider on that same disputed order, so the bank account stays shut', async () => {
    const proofs = build('REVOKED');

    await expect(proofs.getProofFile('order-1', LP_ADDR)).rejects.toThrow(
      'not authorized to view this order’s payment proof',
    );
  });

  it('still serves the payment proof to an APPROVED provider', async () => {
    const proofs = build('APPROVED');

    await expect(proofs.getProofFile('order-1', LP_ADDR)).resolves.toEqual({
      key: 'proofs/order-1.jpg',
      contentType: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('still serves the dispute evidence to an APPROVED provider', async () => {
    const proofs = build('APPROVED');

    await expect(proofs.getDisputeEvidenceFile('order-1', LP_ADDR)).resolves.toEqual({
      key: 'evidence/order-1.png',
      contentType: 'image/png',
      ext: 'png',
    });
  });

  it('still serves an administrator who is also the revoked provider, so the founder wallet keeps its admin reach', async () => {
    const proofs = build('REVOKED', [LP_ADDR]);

    await expect(proofs.getProofFile('order-1', LP_ADDR)).resolves.toMatchObject({
      key: 'proofs/order-1.jpg',
    });
    await expect(proofs.getDisputeEvidenceFile('order-1', LP_ADDR)).resolves.toMatchObject({
      key: 'evidence/order-1.png',
    });
  });

  it('still serves an administrator who is party to neither side', async () => {
    const proofs = build('REVOKED', [ADMIN_ADDR]);

    await expect(proofs.getProofFile('order-1', ADMIN_ADDR)).resolves.toMatchObject({
      key: 'proofs/order-1.jpg',
    });
  });

  it('still serves the depositor whatever became of the provider', async () => {
    const proofs = build('REVOKED');

    await expect(proofs.getProofFile('order-1', USER_ADDR)).resolves.toMatchObject({
      key: 'proofs/order-1.jpg',
    });
  });

  it('refuses a stranger', async () => {
    const proofs = build('APPROVED');

    await expect(proofs.getProofFile('order-1', 'GSTRANGER')).rejects.toThrow(
      'not authorized to view this order’s payment proof',
    );
  });
});
