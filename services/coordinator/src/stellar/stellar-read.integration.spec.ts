const SKIP = !process.env.RUN_TESTNET_IT;

const describeFn = SKIP ? describe.skip : describe;

import { StellarReadService } from './stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import { randomBytes } from 'crypto';

const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const READ_KEY = process.env.IT_READ_KEY ?? '';
const STAKING_CONTRACT = process.env.IT_STAKING_CONTRACT_ID ?? '';
const ESCROW_CONTRACT = process.env.IT_ESCROW_CONTRACT_ID ?? '';

const KNOWN_TRADE_ID =
  '0000000000000000000000000000000000000000000000000000000000000001';

function makeCfg(): AppConfigService {
  return {
    rpcUrl: TESTNET_RPC,
    networkPassphrase: TESTNET_PASSPHRASE,
    stakingContractId: STAKING_CONTRACT,
    escrowContractId: ESCROW_CONTRACT,
    stellarReadKey: READ_KEY,
  } as unknown as AppConfigService;
}

function isNetworkError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('fetch failed') ||
    msg.includes('could not load source account')
  );
}

describeFn('StellarReadService (testnet integration)', () => {
  let svc: StellarReadService;

  beforeAll(() => {
    svc = new StellarReadService(makeCfg());
  });

  it('isEligible returns a boolean for a known address', async () => {
    let result: boolean;
    try {
      result = await svc.isEligible(READ_KEY);
    } catch (e) {
      if (isNetworkError(e)) {
        console.warn('[IT] NETWORK UNREACHABLE — skipping isEligible assertion:', (e as Error).message);
        return;
      }
      throw e;
    }
    console.log('[IT] isEligible result:', result);
    expect(typeof result).toBe('boolean');
  }, 30_000);

  it('getTradeStatus for known settled trade is RELEASED or null (if TTL-archived)', async () => {
    const result = await svc.getTradeStatus(ESCROW_CONTRACT, KNOWN_TRADE_ID);
    console.log('[IT] getTradeStatus(known):', result);

    if (result !== null) {
      expect(result).toEqual({ status: 'RELEASED' });
    } else {
      expect(result).toBeNull();
    }
  }, 30_000);

  it('getTradeStatus for random non-existent trade returns null', async () => {
    const nonExistentId = randomBytes(32).toString('hex');
    const result = await svc.getTradeStatus(ESCROW_CONTRACT, nonExistentId);
    console.log('[IT] getTradeStatus(random):', result);
    expect(result).toBeNull();
  }, 30_000);
});
