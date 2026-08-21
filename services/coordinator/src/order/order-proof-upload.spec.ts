import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub } from './test-helpers';
import { UploadedFileLike } from './upload.util';
import { FakeObjectStorage } from '../storage/object-storage.fake';

const JPG: Buffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 0)]);
const PNG: Buffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0),
]);
const GARBAGE: Buffer = Buffer.from('not a real file', 'ascii');

function jpgFile(overrides: Partial<UploadedFileLike> = {}): UploadedFileLike {
  return { buffer: JPG, mimetype: 'image/jpeg', size: JPG.length, ...overrides };
}

describe('OrderService — payment proof + dispute evidence uploads (Phase 5B Task 3 / 5C Task 2)', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const ADMIN_ADDR = 'GADMIN';
  const STRANGER_ADDR = 'GSTRANGER';
  const PLATFORM = 'GPLATFORM';
  const FAKE_TRADE_ID = 'a'.repeat(64);

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
      contractId: 'CTEST',
      userAddress: USER_ADDR,
      flow: 'WITHDRAW',
      status: 'FUNDED',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: PLATFORM,
      lpWallet: LP_ADDR,
      lpId: 'lp1',
      lp: { stellarAddress: LP_ADDR },
      proofUrl: null,
      proofUploadedAt: null,
      settledAt: null,
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      rail: 'BANK',
      expiresAt: new Date(),
      createdAt: new Date(),
      ...overrides,
    };
  }

  function makeSvc(
    orderOverrides: Partial<any> = {},
    opts: {
      updateManyCount?: number;
      configOverrides?: Partial<any>;
      stellarOverrides?: any;
      rrnClash?: boolean;
    } = {},
  ) {
    let current = makeOrder(orderOverrides);
    const prisma = {
      order: {
        findUnique: jest.fn().mockImplementation(() => Promise.resolve({ ...current })),
        update: jest.fn().mockImplementation(({ data }: any) => {
          current = { ...current, ...data };
          return Promise.resolve({ ...current });
        }),
        updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
          const statusMatches = !('status' in where) || current.status === where.status;
          const proofUrlMatches = !('proofUrl' in where) || current.proofUrl === where.proofUrl;
          const count = opts.updateManyCount ?? (statusMatches && proofUrlMatches ? 1 : 0);
          if (count > 0) current = { ...current, ...data };
          return Promise.resolve({ count });
        }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(opts.rrnClash ? { id: 'other-order' } : null),
        count: jest.fn().mockResolvedValue(0),
      },
      quote: {},
      config: {
        upsert: jest.fn().mockResolvedValue({
          requireProof: true,
          postSettleDisputeWindowSecs: 3600,
          ...opts.configOverrides,
        }),
      },
      lp: { findUnique: jest.fn() },
    } as any;

    const stellar = {
      buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildCreateTradeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildConfirmReleaseTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      buildResolveTx: jest.fn().mockResolvedValue({ xdr: 'x', networkPassphrase: 'p' }),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
      ...opts.stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = {
      platformWallet: PLATFORM,
      escrowContractId: 'CENV',
      adminAddresses: [ADMIN_ADDR],
    } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const storage = new FakeObjectStorage();

    return {
      svc: new OrderService(prisma, stellar, matching, cfg, markets, notifications, storage as any, makeUserReputationStub()),
      prisma,
      stellar,
      storage,
    };
  }

  describe('uploadProof', () => {
    it('order not found → 404', async () => {
      const { svc, prisma } = makeSvc();
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('TOP_UP flow → 400 (LP is never the fiat payer for TOP_UP)', async () => {
      const { svc } = makeSvc({ flow: 'TOP_UP' });
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no LP assigned → 409 (defense-in-depth)', async () => {
      const { svc } = makeSvc({ lp: null, lpId: null });
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(ConflictException);
    });

    it('caller is not the assigned LP → 403', async () => {
      const { svc } = makeSvc();
      await expect(svc.uploadProof('order-1', STRANGER_ADDR, jpgFile())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('the ORDER USER (not the LP) may not upload proof → 403', async () => {
      const { svc } = makeSvc();
      await expect(svc.uploadProof('order-1', USER_ADDR, jpgFile())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('wrong status (not FUNDED) → 409', async () => {
      const { svc } = makeSvc({ status: 'FIAT_PAID' });
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(ConflictException);
    });

    it('missing file → 400', async () => {
      const { svc } = makeSvc();
      await expect(svc.uploadProof('order-1', LP_ADDR, undefined)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unrecognized file content (no magic-bytes match) → 400', async () => {
      const { svc } = makeSvc();
      await expect(
        svc.uploadProof('order-1', LP_ADDR, { buffer: GARBAGE, mimetype: 'image/jpeg', size: GARBAGE.length }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('declared Content-Type does NOT match sniffed bytes (PNG labeled as JPEG) → 400', async () => {
      const { svc } = makeSvc();
      await expect(
        svc.uploadProof('order-1', LP_ADDR, { buffer: PNG, mimetype: 'image/jpeg', size: PNG.length }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a losing race (order left FUNDED by someone else mid-request) → 409, not a crash', async () => {
      const { svc } = makeSvc({}, { updateManyCount: 0 });
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(ConflictException);
    });

    it('a losing race leaves NO new orphan object in the bucket — the just-written object is cleaned up', async () => {
      const { svc, storage } = makeSvc({}, { updateManyCount: 0 });
      const before = storage.size();

      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile())).rejects.toBeInstanceOf(ConflictException);

      expect(storage.size()).toBe(before);
    });

    it('happy path: valid jpg, correct LP, FUNDED status → proofUrl/proofUploadedAt set, order returned', async () => {
      const { svc, prisma, storage } = makeSvc();
      const result = await svc.uploadProof('order-1', LP_ADDR, jpgFile());

      expect(result.proof_url).toMatch(/^proofs\/[0-9a-f-]{36}\.jpg$/);
      expect(storage.has(result.proof_url)).toBe(true);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: 'FUNDED', proofUrl: null },
        data: expect.objectContaining({ proofUrl: expect.stringMatching(/^proofs\//), proofUploadedAt: expect.any(Date) }),
      });
    });

    it('reupload replaces the old object in place: old key gone from the bucket, new one referenced', async () => {
      const { svc, storage } = makeSvc();

      const first = await svc.uploadProof('order-1', LP_ADDR, jpgFile());
      const firstKey = first.proof_url as string;
      expect(storage.has(firstKey)).toBe(true);

      const second = await svc.uploadProof('order-1', LP_ADDR, jpgFile());
      const secondKey = second.proof_url as string;

      expect(secondKey).not.toBe(firstKey);
      expect(second.proof_url).toMatch(/^proofs\/[0-9a-f-]{36}\.jpg$/);

      expect(storage.has(firstKey)).toBe(false);
      expect(storage.has(secondKey)).toBe(true);
    });

    const ORDER_CREATED = new Date(Date.now() - 3_600_000);
    const META = { rrn: 'ref12345', paidAmount: '1600000', paidAt: new Date(Date.now() - 60_000).toISOString() };

    it('WITHDRAW: full metadata → persists uppercased rrn + amount + paidAt', async () => {
      const { svc, prisma } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      await svc.uploadProof('order-1', LP_ADDR, jpgFile(), META);
      const data = prisma.order.updateMany.mock.calls[0][0].data;
      expect(data.proofRrn).toBe('REF12345');
      expect(data.proofAmount).toBe(1_600_000n);
      expect(data.proofPaidAt).toEqual(new Date(META.paidAt));
    });

    it('strips separators + uppercases the RRN before persisting', async () => {
      const { svc, prisma } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      await svc.uploadProof('order-1', LP_ADDR, jpgFile(), { ...META, rrn: 'ref-123 45' });
      expect(prisma.order.updateMany.mock.calls[0][0].data.proofRrn).toBe('REF12345');
    });

    it('dedup is scoped per LP: the pre-check filters on lpId', async () => {
      const { svc, prisma } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      await svc.uploadProof('order-1', LP_ADDR, jpgFile(), META);
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ proofRrn: 'REF12345', lpId: 'lp1' }) }),
      );
    });

    it('rejects a duplicate RRN already used by this LP → 409', async () => {
      const { svc } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED }, { rrnClash: true });
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile(), META)).rejects.toBeInstanceOf(ConflictException);
    });

    it('a P2002 unique-RRN race on write → 409 and cleans up the just-written object', async () => {
      const { svc, prisma, storage } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });

      prisma.order.updateMany.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile(), META)).rejects.toBeInstanceOf(ConflictException);

      expect(storage.keysWithPrefix('proofs/')).toHaveLength(0);
    });

    it('cleans up the just-written object on ANY write failure, not just P2002', async () => {
      const { svc, prisma, storage } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      prisma.order.updateMany.mockRejectedValueOnce(new Error('db down'));
      await expect(svc.uploadProof('order-1', LP_ADDR, jpgFile(), META)).rejects.toThrow('db down');
      expect(storage.keysWithPrefix('proofs/')).toHaveLength(0);
    });

    it('rejects a payment time in the future → 400', async () => {
      const { svc } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      await expect(
        svc.uploadProof('order-1', LP_ADDR, jpgFile(), { ...META, paidAt: future }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a payment time before the order was created → 400', async () => {
      const { svc } = makeSvc({ flow: 'WITHDRAW', createdAt: ORDER_CREATED });
      const predate = new Date(ORDER_CREATED.getTime() - 60_000).toISOString();
      await expect(
        svc.uploadProof('order-1', LP_ADDR, jpgFile(), { ...META, paidAt: predate }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('WITHDRAW: metadata is optional (proof still accepted without rrn)', async () => {
      const { svc } = makeSvc({ flow: 'WITHDRAW' });
      const result = await svc.uploadProof('order-1', LP_ADDR, jpgFile());
      expect(result.proof_url).toMatch(/^proofs\//);
    });
  });

  describe('getProofFile', () => {
    it('order not found → 404', async () => {
      const { svc, prisma } = makeSvc();
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await expect(svc.getProofFile('order-1', USER_ADDR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('no proof uploaded yet → 404', async () => {
      const { svc } = makeSvc({ proofUrl: null });
      await expect(svc.getProofFile('order-1', USER_ADDR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the order USER may view the proof', async () => {
      const { svc } = makeSvc({ proofUrl: 'proofs/abc.jpg' });
      const result = await svc.getProofFile('order-1', USER_ADDR);
      expect(result.contentType).toBe('image/jpeg');
      expect(result.ext).toBe('jpg');
      expect(result.key).toBe('proofs/abc.jpg');
    });

    it('the order LP may view the proof', async () => {
      const { svc } = makeSvc({ proofUrl: 'proofs/abc.png' });
      const result = await svc.getProofFile('order-1', LP_ADDR);
      expect(result.contentType).toBe('image/png');
    });

    it('an admin may view the proof', async () => {
      const { svc } = makeSvc({ proofUrl: 'proofs/abc.pdf' });
      const result = await svc.getProofFile('order-1', ADMIN_ADDR);
      expect(result.contentType).toBe('application/pdf');
    });

    it('a random stranger is forbidden', async () => {
      const { svc } = makeSvc({ proofUrl: 'proofs/abc.jpg' });
      await expect(svc.getProofFile('order-1', STRANGER_ADDR)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unrecognized extension falls back to application/octet-stream (never crashes)', async () => {
      const { svc } = makeSvc({ proofUrl: 'proofs/abc.bin' });
      const result = await svc.getProofFile('order-1', USER_ADDR);
      expect(result.contentType).toBe('application/octet-stream');
      expect(result.ext).toBe('bin');
    });
  });

  describe('getDisputeEvidenceFile', () => {
    it('order not found → 404', async () => {
      const { svc, prisma } = makeSvc();
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await expect(svc.getDisputeEvidenceFile('order-1', USER_ADDR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('no evidence uploaded yet → 404', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: null });
      await expect(svc.getDisputeEvidenceFile('order-1', USER_ADDR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('the order USER may view the evidence', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: 'evidence/order-1-lp.jpg' });
      const result = await svc.getDisputeEvidenceFile('order-1', USER_ADDR);
      expect(result.contentType).toBe('image/jpeg');
      expect(result.ext).toBe('jpg');
      expect(result.key).toBe('evidence/order-1-lp.jpg');
    });

    it('the order LP may view the evidence', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: 'evidence/order-1-user.png' });
      const result = await svc.getDisputeEvidenceFile('order-1', LP_ADDR);
      expect(result.contentType).toBe('image/png');
    });

    it('an admin may view the evidence', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: 'evidence/order-1-user.pdf' });
      const result = await svc.getDisputeEvidenceFile('order-1', ADMIN_ADDR);
      expect(result.contentType).toBe('application/pdf');
    });

    it('a random stranger is forbidden', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: 'evidence/order-1-user.jpg' });
      await expect(svc.getDisputeEvidenceFile('order-1', STRANGER_ADDR)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unrecognized extension falls back to application/octet-stream (never crashes)', async () => {
      const { svc } = makeSvc({ disputeEvidenceUrl: 'evidence/order-1-user.bin' });
      const result = await svc.getDisputeEvidenceFile('order-1', USER_ADDR);
      expect(result.contentType).toBe('application/octet-stream');
      expect(result.ext).toBe('bin');
    });
  });

  describe('uploadDisputeEvidence', () => {
    it('order not found → 404', async () => {
      const { svc, prisma } = makeSvc();
      prisma.order.findUnique.mockResolvedValueOnce(null);
      await expect(svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a non-party (neither user nor LP) is forbidden', async () => {
      const { svc } = makeSvc({ status: 'FIAT_PAID' });
      await expect(svc.uploadDisputeEvidence('order-1', STRANGER_ADDR, jpgFile())).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('FIAT_PAID: the user may upload evidence, order is left untouched', async () => {
      const { svc, prisma } = makeSvc({ status: 'FIAT_PAID' });
      const result = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());
      expect(result.evidence_url).toBe('evidence/order-1-user.jpg');
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('FIAT_PAID: the LP may also upload evidence', async () => {
      const { svc } = makeSvc({ status: 'FIAT_PAID' });
      const result = await svc.uploadDisputeEvidence('order-1', LP_ADDR, jpgFile());
      expect(result.evidence_url).toBe('evidence/order-1-lp.jpg');
    });

    it('reupload by the SAME party overwrites the same deterministic key — no growth in the bucket', async () => {
      const { svc, storage } = makeSvc({ status: 'FIAT_PAID' });

      const first = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());
      const second = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());

      expect(first.evidence_url).toBe('evidence/order-1-user.jpg');
      expect(second.evidence_url).toBe('evidence/order-1-user.jpg');

      expect(storage.keysWithPrefix('evidence/order-1-user.')).toEqual(['evidence/order-1-user.jpg']);
    });

    it('reupload by the SAME party with a DIFFERENT file type removes the stale-extension object — no growth', async () => {
      const { svc, storage } = makeSvc({ status: 'FIAT_PAID' });

      const first = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());
      expect(first.evidence_url).toBe('evidence/order-1-user.jpg');

      const second = await svc.uploadDisputeEvidence('order-1', USER_ADDR, {
        buffer: PNG,
        mimetype: 'image/png',
        size: PNG.length,
      });
      expect(second.evidence_url).toBe('evidence/order-1-user.png');

      expect(storage.keysWithPrefix('evidence/order-1-user.')).toEqual(['evidence/order-1-user.png']);
    });

    it('evidence uploaded by the user and by the LP are separate objects — neither overwrites the other', async () => {
      const { svc, storage } = makeSvc({ status: 'FIAT_PAID' });

      const userResult = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());
      const lpResult = await svc.uploadDisputeEvidence('order-1', LP_ADDR, jpgFile());

      expect(userResult.evidence_url).toBe('evidence/order-1-user.jpg');
      expect(lpResult.evidence_url).toBe('evidence/order-1-lp.jpg');

      expect(storage.has('evidence/order-1-user.jpg')).toBe(true);
      expect(storage.has('evidence/order-1-lp.jpg')).toBe(true);
    });

    it('RELEASED within the post-settle window → allowed', async () => {
      const { svc } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 60_000) });
      const result = await svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile());
      expect(result.evidence_url).toMatch(/^evidence\//);
    });

    it('RELEASED past the post-settle window → 409', async () => {
      const { svc } = makeSvc({ status: 'RELEASED', settledAt: new Date(Date.now() - 999 * 60 * 60 * 1000) });
      await expect(svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('a status that is never disputable (e.g. FUNDED) → 409', async () => {
      const { svc } = makeSvc({ status: 'FUNDED' });
      await expect(svc.uploadDisputeEvidence('order-1', USER_ADDR, jpgFile())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('mismatched Content-Type → 400, even for an otherwise-eligible party/status', async () => {
      const { svc } = makeSvc({ status: 'FIAT_PAID' });
      await expect(
        svc.uploadDisputeEvidence('order-1', USER_ADDR, { buffer: PNG, mimetype: 'image/jpeg', size: PNG.length }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('buildMarkFiatPaidTx — requireProof gate', () => {
    it('requireProof=true, LP-pays-fiat (WITHDRAW), no proof uploaded → 400', async () => {
      const { svc } = makeSvc({ status: 'FUNDED', proofUrl: null }, { configOverrides: { requireProof: true } });
      await expect(svc.buildMarkFiatPaidTx('order-1', LP_ADDR)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requireProof=true, LP-pays-fiat (WITHDRAW), proof already uploaded → succeeds', async () => {
      const { svc } = makeSvc(
        { status: 'FUNDED', proofUrl: 'proofs/abc.jpg' },
        { configOverrides: { requireProof: true } },
      );
      const result = await svc.buildMarkFiatPaidTx('order-1', LP_ADDR);
      expect(result.xdr).toBe('x');
    });

    it('requireProof=false → succeeds even with no proof uploaded', async () => {
      const { svc } = makeSvc({ status: 'FUNDED', proofUrl: null }, { configOverrides: { requireProof: false } });
      const result = await svc.buildMarkFiatPaidTx('order-1', LP_ADDR);
      expect(result.xdr).toBe('x');
    });

    it('TOP_UP is never gated by requireProof — the USER (fiat payer) may mark paid with no proofUrl at all', async () => {
      const { svc } = makeSvc(
        {
          flow: 'TOP_UP',
          status: 'FUNDED',
          proofUrl: null,
          lp: { stellarAddress: LP_ADDR },
          lpId: 'lp1',
        },
        { configOverrides: { requireProof: true } },
      );
      const result = await svc.buildMarkFiatPaidTx('order-1', USER_ADDR);
      expect(result.xdr).toBe('x');
    });
  });
});
