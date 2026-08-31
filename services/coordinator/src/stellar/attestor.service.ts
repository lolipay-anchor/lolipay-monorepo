import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';
import { AppConfigService } from '../config/app-config.service';
import { StellarReadService } from './stellar-read.service';
import { assertIsThisTradesAttestation } from './attest-guard';
import { signSendAndPoll } from './sign-send-poll';

const STELLAR_SECRET_RE = /^S[A-Z2-7]{55}$/;

@Injectable()
export class AttestorService {
  private readonly log = new Logger('Attestor');

  private keypairResolved = false;
  private cachedKeypair: Keypair | null = null;
  private confirmedContracts = new Set<string>();

  protected pollIntervalMs = 2000;
  protected pollTimeoutMs = 30_000;

  constructor(
    private cfg: AppConfigService,
    private stellarRead: StellarReadService,
  ) {}

  get isConfigured(): boolean {
    return this.resolveKeypair() !== null;
  }

  private resolveKeypair(): Keypair | null {
    if (this.keypairResolved) return this.cachedKeypair;
    this.keypairResolved = true;

    const secret = this.cfg.attestorSecret;
    if (!secret) {
      this.cachedKeypair = null;
      return null;
    }
    if (!STELLAR_SECRET_RE.test(secret)) {
      this.log.warn(
        'ATTESTOR_SECRET is set but is not a well-formed Stellar secret key (S...) — no deposit can be attested',
      );
      this.cachedKeypair = null;
      return null;
    }
    try {
      this.cachedKeypair = Keypair.fromSecret(secret);
    } catch {
      this.log.warn('ATTESTOR_SECRET failed checksum validation — no deposit can be attested');
      this.cachedKeypair = null;
    }
    return this.cachedKeypair;
  }

  async attest(contractId: string, tradeIdHex: string): Promise<{ status: string; hash: string }> {
    const kp = this.resolveKeypair();
    if (!kp) {
      throw new ServiceUnavailableException(
        'this anchor cannot attest deposits right now: no attestor key is configured',
      );
    }
    if (![this.cfg.escrowContractId, ...this.cfg.escrowContractIdsExtra].includes(contractId)) {
      throw new Error(
        `AttestorService: ${contractId} is not an escrow this anchor recognises, so nothing it says about itself can be trusted`,
      );
    }
    await this.assertIsTheChainsAttestor(contractId, kp.publicKey());

    const { xdr, networkPassphrase } = await this.stellarRead.buildMarkFiatPaidTx(
      contractId,
      kp.publicKey(),
      tradeIdHex,
    );
    const tx = new Transaction(xdr, networkPassphrase);
    assertIsThisTradesAttestation(tx, { contractId, tradeIdHex, attestor: kp.publicKey() });

    return signSendAndPoll(tx, kp, {
      label: 'AttestorService',
      noun: 'attestation',
      log: this.log,
      server: this.createRpcServer(),
      pollIntervalMs: this.pollIntervalMs,
      pollTimeoutMs: this.pollTimeoutMs,
    });
  }

  private async assertIsTheChainsAttestor(contractId: string, held: string): Promise<void> {
    if (this.confirmedContracts.has(contractId)) return;
    const onChain = await this.stellarRead.readEscrowFiatAttestor(contractId);
    if (onChain !== held) {
      throw new Error(
        `AttestorService: this key is not the attestor ${contractId} names — it names ${onChain}, and that is immutable`,
      );
    }
    this.confirmedContracts.add(contractId);
  }

  protected createRpcServer(): Server {
    return new Server(this.cfg.rpcUrl);
  }
}
