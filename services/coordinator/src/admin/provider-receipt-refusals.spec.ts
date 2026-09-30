import { ForbiddenException, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { Keypair } from '@stellar/stellar-sdk';
import { AdminService } from './admin.service';
import { PROVIDER_SERVER_ERROR, providerReceiptMessage } from './provider-receipt-message';
import { sep53Signature } from '../scripts/sep24-fixtures';

const PROVIDER = Keypair.random();
const CALLER = PROVIDER.publicKey();
const ORDER_ID = '3b2f6c1e-8a47-4d19-9c0e-5f1a2b7d9e40';
const NOT_FOUND = 'This order was not found.';
const HASH = 'b'.repeat(64);

function orderRow() {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: ORDER_ID,
    tradeId: '9'.repeat(64),
    contractId: 'CESCROWTHISORDERWASCREATEDON',
    flow: 'TOP_UP',
    status: 'FUNDED',
    fiatAmount: 1_500_000n,
    fiatCurrency: 'IDR',
    ref: 'LP-7K2Q',
    payDeadline: BigInt(now + 600),
    confirmDeadline: BigInt(now + 1800),
    lp: { stellarAddress: CALLER },
  };
}

function stage() {
  const prisma = {
    order: { findUnique: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) },
    adminAudit: { create: jest.fn(async () => ({})) },
  };
  prisma.order.findUnique.mockResolvedValue(orderRow());
  const stellar = {
    getTradeStatusStrict: jest.fn(async () => ({
      status: 'FUNDED',
      settledAt: 0,
      flow: 0,
      usdcProvider: CALLER,
      usdcRecipient: 'GTHEDEPOSITOR',
      confirmer: CALLER,
    })),
  };
  const attestor = { attest: jest.fn(async () => ({ status: 'SUCCESS', hash: HASH })) };
  const consumed = { consume: jest.fn(async () => true) };
  const cfg = { escrowContractId: 'CCURRENTESCROWFROMCONFIG', challengeTtl: 97 };
  const svc = new AdminService(
    prisma as any,
    stellar as any,
    cfg as any,
    {} as any,
    {} as any,
    attestor as any,
    { notifyOrderStatus: jest.fn() } as any,
  );
  Object.assign(svc, { consumed });
  return { svc, prisma, stellar, attestor, consumed };
}

function freshProof() {
  const at = Math.floor(Date.now() / 1000);
  return { at, signature: sep53Signature(PROVIDER, providerReceiptMessage(orderRow(), at)) };
}

async function refusal(work: Promise<unknown>): Promise<any> {
  try {
    await work;
  } catch (err) {
    return err;
  }
  throw new Error('the route was expected to refuse');
}

const SERVER_ERROR_BODY = { statusCode: 500, error: 'Internal Server Error', message: PROVIDER_SERVER_ERROR };

describe('what a provider reads when the route meets something it did not anticipate', () => {
  afterEach(() => jest.restoreAllMocks());

  it('gives the step-1 sentence when the core reports the order gone after the route had already read it', async () => {
    const s = stage();
    s.prisma.order.findUnique.mockResolvedValueOnce(orderRow()).mockResolvedValueOnce(null);

    const refused = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    expect(refused).toBeInstanceOf(NotFoundException);
    expect(refused.getResponse()).toEqual({ statusCode: 404, error: 'Not Found', message: NOT_FOUND });
    expect(s.attestor.attest).not.toHaveBeenCalled();
  });

  it('gives the one 5xx sentence with status 500 and none of the raw text when the order read fails, on both routes, and logs the raw text', async () => {
    const s = stage();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    s.prisma.order.findUnique.mockRejectedValue(new Error('connection refused by 10.0.0.5'));

    const onGet = await refusal(s.svc.receiptToSign(ORDER_ID, CALLER));
    const onPost = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    for (const refused of [onGet, onPost]) {
      expect(refused).toBeInstanceOf(InternalServerErrorException);
      expect(refused.getResponse()).toEqual(SERVER_ERROR_BODY);
    }
    expect(logged.mock.calls.filter(([line]) => String(line).includes('connection refused by 10.0.0.5'))).toHaveLength(2);
  });

  it('keeps the raw text of a failed chain read in the log and out of the 409 sentence the provider reads', async () => {
    const s = stage();
    const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    s.stellar.getTradeStatusStrict.mockRejectedValue(new Error('rpc timeout to 10.0.0.9'));

    const refused = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    expect(refused.getStatus()).toBe(409);
    expect(JSON.stringify(refused.getResponse())).not.toContain('10.0.0.9');
    expect(warned.mock.calls.some(([line]) => String(line).includes('rpc timeout to 10.0.0.9'))).toBe(true);
    expect(s.attestor.attest).not.toHaveBeenCalled();
  });

  it('gives the one 5xx sentence when recording the single use fails, before the chain or the attestor are touched', async () => {
    const s = stage();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    s.consumed.consume.mockRejectedValue(new Error('too many connections'));

    const refused = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    expect(refused).toBeInstanceOf(InternalServerErrorException);
    expect(refused.getResponse()).toEqual(SERVER_ERROR_BODY);
    expect(s.stellar.getTradeStatusStrict).not.toHaveBeenCalled();
    expect(s.attestor.attest).not.toHaveBeenCalled();
  });

  it('gives the one 5xx sentence when moving the row fails after the attestation landed, and the attestation is not attempted twice', async () => {
    const s = stage();
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    s.prisma.order.updateMany.mockRejectedValue(new Error('deadlock detected'));

    const refused = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    expect(refused).toBeInstanceOf(InternalServerErrorException);
    expect(refused.getResponse()).toEqual(SERVER_ERROR_BODY);
    expect(s.attestor.attest).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls.some(([line]) => String(line).includes('deadlock detected'))).toBe(true);
  });

  it('gives the one 5xx sentence with status 500, never the core\'s own words, for a refusal status the route has no sentence for', async () => {
    const s = stage();
    s.attestor.attest.mockRejectedValueOnce(new ForbiddenException('operator-only words about the attestor'));

    const refused = await refusal(s.svc.confirmReceiptAsProvider(ORDER_ID, CALLER, freshProof()));

    expect(refused.getStatus()).toBe(500);
    expect(refused.message).toBe(PROVIDER_SERVER_ERROR);
    expect(JSON.stringify(refused.getResponse())).not.toContain('operator-only');
  });
});
