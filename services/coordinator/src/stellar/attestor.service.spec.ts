import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ServiceUnavailableException } from '@nestjs/common';
import { AttestorService } from './attestor.service';

const CONTRACT = 'CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z';
const TRADE = 'ab'.repeat(32);

function makeSvc(secret: string | undefined, onChainAttestor?: string) {
  const cfg = { attestorSecret: secret, rpcUrl: 'https://example.invalid' } as any;
  const built = jest.fn();
  const read = {
    readEscrowFiatAttestor: jest.fn(async () => onChainAttestor ?? 'GUNSET'),
    buildMarkFiatPaidTx: built,
  } as any;
  return { svc: new AttestorService(cfg, read), read, built };
}

describe('the attestor refuses before it signs, not after', () => {
  it('is not configured when the secret is absent', () => {
    expect(makeSvc(undefined).svc.isConfigured).toBe(false);
  });

  it('is not configured when the secret is malformed, and says so rather than throwing at boot', () => {
    expect(makeSvc('not-a-stellar-secret').svc.isConfigured).toBe(false);
  });

  it('refuses to attest at all when unconfigured, as unavailable rather than broken', async () => {
    const { svc, built } = makeSvc(undefined);
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/attestor key is configured/i);
    expect(built).not.toHaveBeenCalled();
  });

  it('refuses a key the chain does not name as attestor, and never builds a transaction', async () => {
    const kp = Keypair.random();
    const { svc, built } = makeSvc(kp.secret(), Keypair.random().publicKey());

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/is not the attestor/i);

    expect(built).not.toHaveBeenCalled();
  });

  it('names the immutability in the refusal, because a wrong key cannot be fixed by config', async () => {
    const kp = Keypair.random();
    const { svc } = makeSvc(kp.secret(), Keypair.random().publicKey());
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/immutable/i);
  });

  it('asks the chain once per contract, not once per attestation', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');
    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');

    expect(read.readEscrowFiatAttestor).toHaveBeenCalledTimes(1);
  });

  function preparedFor(opts: { contractId?: string; tradeIdHex?: string; caller: string }) {
    const src = new Account(Keypair.random().publicKey(), '1');
    const tx = new TransactionBuilder(src, { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.invokeContractFunction({
          contract: opts.contractId ?? CONTRACT,
          function: 'mark_fiat_paid',
          args: [
            xdr.ScVal.scvBytes(Buffer.from(opts.tradeIdHex ?? TRADE, 'hex')),
            new Address(opts.caller).toScVal(),
          ],
        }),
      )
      .setTimeout(30)
      .build();
    return { xdr: tx.toXdr(), networkPassphrase: Networks.TESTNET };
  }

  it('refuses to sign an envelope naming a different trade than the one it was asked to attest', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(
      preparedFor({ tradeIdHex: 'cd'.repeat(32), caller: kp.publicKey() }),
    );

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/refused to sign/i);
  });

  it('refuses to sign an envelope pointed at a different escrow contract', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockResolvedValue(
      preparedFor({
        contractId: 'CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2',
        caller: kp.publicKey(),
      }),
    );

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow(/refused to sign/i);
  });

  it('builds against the contract and trade it was given, signing as itself', async () => {
    const kp = Keypair.random();
    const { svc, read } = makeSvc(kp.secret(), kp.publicKey());
    read.buildMarkFiatPaidTx.mockRejectedValue(new Error('stop here'));

    await expect(svc.attest(CONTRACT, TRADE)).rejects.toThrow('stop here');

    expect(read.buildMarkFiatPaidTx).toHaveBeenCalledWith(CONTRACT, kp.publicKey(), TRADE);
  });
});
