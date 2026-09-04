import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  Address,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from '@stellar/stellar-sdk';

const FLOW_DISCRIMINANT: Record<string, number> = {
  TOP_UP: 0,
  WITHDRAW: 1,
};

export interface BuildCreateTradeTxParams {
  contractId: string;
  tradeIdHex: string;
  usdcProvider: string;
  usdcRecipient: string;
  confirmer: string;
  usdcAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string;

  flow: string;
  platformFeeBps: number;
  lpFeeBps: number;
  platformWallet: string;
  lpWallet: string;
  payDeadline: bigint;
  confirmDeadline: bigint;
  disputeDeadline: bigint;
}
import { Api, Server } from '@stellar/stellar-sdk/rpc';
import { AppConfigService } from '../config/app-config.service';
import { signingDeadlineSecs } from '../config/contract-limits';
import { TradeOnChain } from './stellar-read.types';

export { TradeOnChain } from './stellar-read.types';

export const STATUS_MAP = ['FUNDED', 'FIAT_PAID', 'RELEASED', 'REFUNDED', 'DISPUTED'] as const;

const NOT_FOUND_PATTERNS = ['not found', 'key not found', 'missingvalue'];

function isNotFound(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return NOT_FOUND_PATTERNS.some((p) => msg.includes(p));
}

const USE_UPGRADED_SOROBAN_AUTH = false;

const STELLAR_ADDRESS_RE = /^[GCM][A-Z2-7]{55}$/;

function asBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  return undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined;
  if (v && typeof (v as { toString?: unknown }).toString === 'function') {
    const s = String(v);
    if (STELLAR_ADDRESS_RE.test(s)) return s;
  }
  return undefined;
}

const ESCROW_TRADE_NOT_FOUND_RE = /error\(contract,\s*#5\)/i;

function isEscrowTradeNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return ESCROW_TRADE_NOT_FOUND_RE.test(msg);
}

@Injectable()
export class StellarReadService {
  constructor(private cfg: AppConfigService) {}

  private trustlineCache = new Map<string, { has: boolean; at: number }>();
  private static TRUSTLINE_TTL_MS = 5 * 60_000;

  async hasUsdcTrustline(address: string): Promise<boolean> {
    const now = Date.now();
    const cached = this.trustlineCache.get(address);
    if (cached && now - cached.at < StellarReadService.TRUSTLINE_TTL_MS) return cached.has;
    try {
      const res = await withRpcTimeout(
        fetch(`${this.cfg.horizonUrl}/accounts/${encodeURIComponent(address)}`),
        'horizon',
      );
      if (res.status === 404) {
        return false;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          balances?: { asset_code?: string; asset_issuer?: string }[];
        };
        const has = (data.balances ?? []).some(
          (b) => b.asset_code === this.cfg.usdcAssetCode && b.asset_issuer === this.cfg.usdcAssetIssuer,
        );
        if (has) this.trustlineCache.set(address, { has, at: now });
        return has;
      }
      throw new ServiceUnavailableException(
        'cannot verify the USDC trustline right now — please retry in a moment',
      );
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(
        'cannot verify the USDC trustline right now — please retry in a moment',
      );
    }
  }

  private walletAgeCache = new Map<string, { val: string | null; at: number }>();
  private static WALLET_AGE_TTL_MS = 5 * 60_000;

  async getAccountFirstTxAt(address: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.walletAgeCache.get(address);
    if (cached && now - cached.at < StellarReadService.WALLET_AGE_TTL_MS) return cached.val;
    try {
      const res = await withRpcTimeout(
        fetch(
          `${this.cfg.horizonUrl}/accounts/${encodeURIComponent(address)}/transactions?order=asc&limit=1&include_failed=false`,
        ),
        'horizon',
      );
      if (res.status === 404) {
        this.walletAgeCache.set(address, { val: null, at: now });
        return null;
      }
      if (res.ok) {
        const data = (await res.json()) as {
          _embedded?: { records?: { created_at?: string }[] };
        };
        const createdAt = data._embedded?.records?.[0]?.created_at ?? null;
        this.walletAgeCache.set(address, { val: createdAt, at: now });
        return createdAt;
      }
      return null;
    } catch {
      return null;
    }
  }

  async isEligible(lp: string): Promise<boolean> {
    const ret = await this.simulateCall(
      this.cfg.stakingContractId,
      'is_eligible',
      [nativeToScVal(new Address(lp), { type: 'address' })],
    );
    return Boolean(ret);
  }

  private statusCache = new Map<string, { val: TradeOnChain | null; at: number }>();

  async getTradeStatus(contractId: string, tradeIdHex: string): Promise<TradeOnChain | null> {
    const now = Date.now();
    const cacheKey = `${contractId}:${tradeIdHex}`;
    const hit = this.statusCache.get(cacheKey);
    if (hit && now - hit.at < STATUS_CACHE_TTL_MS) return hit.val;

    let val: TradeOnChain | null;
    try {
      val = await this.decodeTradeStatus(contractId, tradeIdHex);
    } catch {
      val = null;
    }
    this.statusCache.set(cacheKey, { val, at: now });

    if (this.statusCache.size > 500) {
      for (const [k, v] of this.statusCache) {
        if (now - v.at >= STATUS_CACHE_TTL_MS) this.statusCache.delete(k);
      }
    }
    return val;
  }

  async getTradeStatusStrict(contractId: string, tradeIdHex: string): Promise<TradeOnChain | null> {
    return this.decodeTradeStatus(contractId, tradeIdHex);
  }

  private async decodeTradeStatus(contractId: string, tradeIdHex: string): Promise<TradeOnChain | null> {
    let ret: any;
    try {
      ret = await this.simulateCall(
        contractId,
        'get_trade',
        [nativeToScVal(Buffer.from(tradeIdHex, 'hex'))],
      );
    } catch (err) {
      if (isNotFound(err) || isEscrowTradeNotFoundError(err)) return null;

      throw err;
    }
    if (!ret) return null;

    const idx = Number(ret.status);
    if (!Number.isInteger(idx) || idx < 0 || idx >= STATUS_MAP.length) return null;

    const settledAtRaw = Number(ret.settled_at ?? 0);
    const settledAt = Number.isFinite(settledAtRaw) && settledAtRaw > 0 ? settledAtRaw : 0;

    return {
      status: STATUS_MAP[idx],
      settledAt,
      usdcAmount: asBigInt(ret.usdc_amount),
      fiatAmount: asBigInt(ret.fiat_amount),
      fiatCurrency: asString(ret.fiat_currency),
      flow: asNumber(ret.flow),
      usdcProvider: asString(ret.usdc_provider),
      usdcRecipient: asString(ret.usdc_recipient),
      confirmer: asString(ret.confirmer),
      platformWallet: asString(ret.platform_wallet),
      lpWallet: asString(ret.lp_wallet),
      platformFeeBps: asNumber(ret.platform_fee_bps),
      lpFeeBps: asNumber(ret.lp_fee_bps),
      payDeadline: asBigInt(ret.pay_deadline),
      confirmDeadline: asBigInt(ret.confirm_deadline),
      disputeDeadline: asBigInt(ret.dispute_deadline),
      postSettleDeadline: asBigInt(ret.post_settle_deadline),
      slashDeadline: asBigInt(ret.slash_deadline),
      liabilityEstablished:
        typeof ret.liability_established === 'boolean' ? ret.liability_established : undefined,
    };
  }

  async buildMarkFiatPaidTx(
    contractId: string,
    userAddress: string,
    tradeIdHex: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();

    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(userAddress), 'getAccount');
    } catch {
      throw new Error(
        `buildMarkFiatPaidTx: could not load account ${userAddress} from Stellar RPC`,
      );
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'mark_fiat_paid',

          args: [
            nativeToScVal(Buffer.from(tradeIdHex, 'hex')),
            new Address(userAddress).toScVal(),
          ],
        }),
      )
      .setTimeout(300)
      .build();

    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildMarkFiatPaidTx: prepareTransaction failed: ${msg}`);
    }

    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildCreateTradeTx(
    params: BuildCreateTradeTxParams,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();

    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(params.usdcProvider), 'getAccount');
    } catch {
      throw new Error(
        `buildCreateTradeTx: could not load account ${params.usdcProvider} from Stellar RPC`,
      );
    }

    const flowDiscriminant = FLOW_DISCRIMINANT[params.flow];
    if (flowDiscriminant === undefined) {
      throw new Error(`buildCreateTradeTx: unknown flow "${params.flow}"`);
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: params.contractId,
          function: 'create_trade',
          args: [

            nativeToScVal(Buffer.from(params.tradeIdHex, 'hex')),

            nativeToScVal(new Address(params.usdcProvider), { type: 'address' }),

            nativeToScVal(new Address(params.usdcRecipient), { type: 'address' }),

            nativeToScVal(new Address(params.confirmer), { type: 'address' }),

            nativeToScVal(params.usdcAmount, { type: 'i128' }),

            nativeToScVal(params.fiatAmount, { type: 'i128' }),

            nativeToScVal(params.fiatCurrency, { type: 'symbol' }),

            nativeToScVal(flowDiscriminant, { type: 'u32' }),

            nativeToScVal(params.platformFeeBps, { type: 'u32' }),

            nativeToScVal(params.lpFeeBps, { type: 'u32' }),

            nativeToScVal(new Address(params.platformWallet), { type: 'address' }),

            nativeToScVal(new Address(params.lpWallet), { type: 'address' }),

            nativeToScVal(params.payDeadline, { type: 'u64' }),

            nativeToScVal(params.confirmDeadline, { type: 'u64' }),

            nativeToScVal(params.disputeDeadline, { type: 'u64' }),
          ],
        }),
      )
      .setTimebounds(0, Math.max(1, Math.min(Math.floor(Date.now() / 1000) + 300, signingDeadlineSecs(Number(params.payDeadline)))))
      .build();

    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildCreateTradeTx: prepareTransaction failed: ${msg}`);
    }

    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildConfirmReleaseTx(
    contractId: string,
    confirmerAddress: string,
    tradeIdHex: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();

    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(confirmerAddress), 'getAccount');
    } catch {
      throw new Error(
        `buildConfirmReleaseTx: could not load account ${confirmerAddress} from Stellar RPC`,
      );
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'confirm_and_release',

          args: [nativeToScVal(Buffer.from(tradeIdHex, 'hex'))],
        }),
      )
      .setTimeout(300)
      .build();

    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildConfirmReleaseTx: prepareTransaction failed: ${msg}`);
    }

    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildRaiseDisputeTx(
    contractId: string,
    byAddress: string,
    tradeIdHex: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(byAddress), 'getAccount');
    } catch {
      throw new Error(`buildRaiseDisputeTx: could not load account ${byAddress} from Stellar RPC`);
    }
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'raise_dispute',
          args: [
            nativeToScVal(Buffer.from(tradeIdHex, 'hex')),
            nativeToScVal(new Address(byAddress), { type: 'address' }),
          ],
        }),
      )
      .setTimeout(300)
      .build();
    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildRaiseDisputeTx: prepareTransaction failed: ${msg}`);
    }
    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildResolveTx(
    contractId: string,
    callerAddress: string,
    tradeIdHex: string,
    outcome: 'release' | 'refund',
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(callerAddress), 'getAccount');
    } catch {
      throw new Error(`buildResolveTx: could not load account ${callerAddress} from Stellar RPC`);
    }
    const outcomeU32 = outcome === 'release' ? 0 : 1;
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'resolve',
          args: [
            nativeToScVal(Buffer.from(tradeIdHex, 'hex')),
            nativeToScVal(outcomeU32, { type: 'u32' }),
            nativeToScVal(new Address(callerAddress), { type: 'address' }),
          ],
        }),
      )
      .setTimeout(300)
      .build();
    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildResolveTx: prepareTransaction failed: ${msg}`);
    }
    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async stakingCooldownSecs(): Promise<number> {
    const ret = await this.simulateCall(this.cfg.stakingContractId, 'get_config', []);
    return Number(BigInt(ret.cooldown_secs));
  }

  async getSlashedSoFar(tradeIdHex: string): Promise<bigint> {
    const ret = await this.simulateCall(
      this.cfg.stakingContractId,
      'slashed',
      [nativeToScVal(Buffer.from(tradeIdHex, 'hex'))],
    );
    return BigInt(ret ?? 0);
  }

  async buildSlashTx(
    callerAddress: string,
    lpAddress: string,
    tradeIdHex: string,
    amount: bigint,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(callerAddress), 'getAccount');
    } catch {
      throw new Error(`buildSlashTx: could not load account ${callerAddress} from Stellar RPC`);
    }
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.cfg.stakingContractId,
          function: 'slash',
          args: [
            nativeToScVal(new Address(lpAddress), { type: 'address' }),
            nativeToScVal(Buffer.from(tradeIdHex, 'hex')),
            nativeToScVal(amount, { type: 'i128' }),
            nativeToScVal(new Address(callerAddress), { type: 'address' }),
          ],
        }),
      )
      .setTimeout(300)
      .build();
    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildSlashTx: prepareTransaction failed: ${msg}`);
    }
    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildRefundTx(
    contractId: string,
    tradeIdHex: string,
    sourceAddr: string,
  ): Promise<Transaction> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(sourceAddr), 'getAccount');
    } catch {
      throw new Error(`buildRefundTx: could not load account ${sourceAddr} from Stellar RPC`);
    }
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: 'refund',

          args: [nativeToScVal(Buffer.from(tradeIdHex, 'hex'))],
        }),
      )
      .setTimeout(300)
      .build();

    try {
      return await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildRefundTx: prepareTransaction failed: ${msg}`);
    }
  }

  async buildStakeTx(
    lpAddress: string,
    amount: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();

    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(lpAddress), 'getAccount');
    } catch {
      throw new Error(
        `buildStakeTx: could not load account ${lpAddress} from Stellar RPC`,
      );
    }

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.cfg.stakingContractId,
          function: 'stake',
          args: [

            nativeToScVal(new Address(lpAddress), { type: 'address' }),

            nativeToScVal(BigInt(amount), { type: 'i128' }),
          ],
        }),
      )
      .setTimeout(300)
      .build();

    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildStakeTx: prepareTransaction failed: ${msg}`);
    }

    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildRequestUnstakeTx(
    lpAddress: string,
    amount: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(lpAddress), 'getAccount');
    } catch {
      throw new Error(
        `buildRequestUnstakeTx: could not load account ${lpAddress} from Stellar RPC`,
      );
    }
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.cfg.stakingContractId,
          function: 'request_unstake',
          args: [
            nativeToScVal(new Address(lpAddress), { type: 'address' }),
            nativeToScVal(BigInt(amount), { type: 'i128' }),
          ],
        }),
      )
      .setTimeout(300)
      .build();
    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildRequestUnstakeTx: prepareTransaction failed: ${msg}`);
    }
    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async buildClaimUnstakeTx(
    lpAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    const server = this.createRpcServer();
    let account;
    try {
      account = await withRpcRetry(() => server.getAccount(lpAddress), 'getAccount');
    } catch {
      throw new Error(
        `buildClaimUnstakeTx: could not load account ${lpAddress} from Stellar RPC`,
      );
    }
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: this.cfg.stakingContractId,
          function: 'claim_unstake',
          args: [nativeToScVal(new Address(lpAddress), { type: 'address' })],
        }),
      )
      .setTimeout(300)
      .build();
    let preparedTx;
    try {
      preparedTx = await withRpcRetry(() => server.prepareTransaction(tx, USE_UPGRADED_SOROBAN_AUTH), 'prepareTransaction');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`buildClaimUnstakeTx: prepareTransaction failed: ${msg}`);
    }
    return { xdr: preparedTx.toXdr(), networkPassphrase: this.cfg.networkPassphrase };
  }

  async getStakeInfo(lpAddress: string): Promise<{
    staked: string;
    unbonding: string;
    unbond_available_at: number;
    min_stake: string;
    eligible: boolean;
  }> {
    const addrArg = nativeToScVal(new Address(lpAddress), { type: 'address' });

    const [stakeRaw, configRaw, eligibleRaw] = await Promise.all([
      this.simulateCall(this.cfg.stakingContractId, 'get_stake', [addrArg]),
      this.simulateCall(this.cfg.stakingContractId, 'get_config', []),
      this.simulateCall(this.cfg.stakingContractId, 'is_eligible', [addrArg]),
    ]);

    return {
      staked: BigInt(stakeRaw.staked).toString(),
      unbonding: BigInt(stakeRaw.unbonding).toString(),
      unbond_available_at: Number(BigInt(stakeRaw.unbond_available_at)),
      min_stake: BigInt(configRaw.min_stake).toString(),
      eligible: Boolean(eligibleRaw),
    };
  }

  protected createRpcServer(): Server {
    return new Server(this.cfg.rpcUrl);
  }

  async latestLedgerCloseTime(): Promise<Date> {
    const latest = await withRpcRetry(() => this.createRpcServer().getLatestLedger(), 'getLatestLedger');
    const seconds = Number(latest?.closeTime);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(`getLatestLedger answered without a readable closeTime: ${JSON.stringify(latest?.closeTime)}`);
    }
    return new Date(seconds * 1000);
  }

  async readEscrowResolver(contractId: string): Promise<string> {
    const cfg = await this.simulateCall(contractId, 'get_config', []);
    const resolver = cfg?.resolver;
    if (typeof resolver !== 'string' || resolver.length === 0) {
      throw new Error(`readEscrowResolver: ${contractId} returned no resolver`);
    }
    return resolver;
  }

  async readEscrowPlatformFeeBps(contractId: string): Promise<number> {
    const cfg = await this.simulateCall(contractId, 'get_config', []);
    const bps = Number(cfg?.default_platform_fee_bps);
    if (!Number.isInteger(bps) || bps < 0) {
      throw new Error(`readEscrowPlatformFeeBps: ${contractId} returned no readable default_platform_fee_bps`);
    }
    return bps;
  }

  async readEscrowFiatAttestor(contractId: string): Promise<string> {
    const cfg = await this.simulateCall(contractId, 'get_config', []);
    const attestor = cfg?.fiat_attestor;
    if (typeof attestor !== 'string' || attestor.length === 0) {
      throw new Error(`readEscrowFiatAttestor: ${contractId} returned no fiat_attestor`);
    }
    return attestor;
  }

  protected async simulateCall(
    contractId: string,
    fn: string,
    args: any[],
  ): Promise<any> {
    const server = new Server(this.cfg.rpcUrl);

    const sourcePubkey = this.cfg.stellarReadKey ?? Keypair.random().publicKey();
    const acct = await withRpcRetry(() => server.getAccount(sourcePubkey), 'getAccount').catch(() => {
      throw new Error(
        `simulateCall: could not load source account for simulation. ` +
          `Set STELLAR_READ_KEY to a funded testnet public key.`,
      );
    });

    const tx = new TransactionBuilder(acct, {
      fee: BASE_FEE,
      networkPassphrase: this.cfg.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: fn,
          args,
        }),
      )
      .setTimeout(30)
      .build();

    return withRpcRetry(async () => {
      const sim = await withRpcTimeout(server.simulateTransaction(tx), 'simulateTransaction');
      if (Api.isSimulationError(sim)) throw new Error(sim.error);
      if (!sim.result) throw new Error(`simulateCall: no result for ${fn}`);
      return scValToNative(sim.result.retval);
    }, 'simulateTransaction');
  }
}

const RPC_TIMEOUT_MS = 5000;
const STATUS_CACHE_TTL_MS = 4000;
export function withRpcTimeout<T>(p: Promise<T>, label: string, ms = RPC_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), timeout]);
}

const RPC_RETRY_ATTEMPTS = 3;

const RPC_RETRY_BACKOFF_MS = [250, 750];

const RETRYABLE_ERROR_SUBSTRINGS = [
  'timed out',
  'timeout',
  'network',
  'fetch failed',
  'econnreset',
  'econnrefused',
  'enotfound',
  'etimedout',
  'could not load source account',
  'could not load account',
];

const RETRYABLE_STATUS_RE = /\b(429|500|502|503|504)\b/;

export function isRetryableRpcError(err: unknown): boolean {
  if (isNotFound(err)) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (RETRYABLE_ERROR_SUBSTRINGS.some((p) => msg.includes(p))) return true;
  return RETRYABLE_STATUS_RE.test(msg);
}

export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: { attempts?: number; timeoutMs?: number },
): Promise<T> {
  const attempts = opts?.attempts ?? RPC_RETRY_ATTEMPTS;
  const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withRpcTimeout(fn(), label, timeoutMs);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isRetryableRpcError(err)) throw err;
      const delay = RPC_RETRY_BACKOFF_MS[Math.min(attempt - 1, RPC_RETRY_BACKOFF_MS.length - 1)];
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastErr;
}
