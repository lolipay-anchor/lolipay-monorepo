import { Address, Transaction, scValToNative } from '@stellar/stellar-sdk';

export const MAX_ATTEST_FEE_STROOPS = 10_000_000;

export interface AttestationBinding {
  contractId: string;
  tradeIdHex: string;
  attestor: string;
}

export function assertIsThisTradesAttestation(
  tx: Transaction,
  expected: AttestationBinding,
): void {
  const refuse = (why: string): never => {
    throw new Error(`AttestorService: refused to sign — ${why}`);
  };

  if (tx.operations.length !== 1) {
    refuse(`expected exactly 1 operation, got ${tx.operations.length}`);
  }
  const fee = Number(tx.fee);
  if (!Number.isFinite(fee) || fee > MAX_ATTEST_FEE_STROOPS) {
    refuse(`expected a fee at or under ${MAX_ATTEST_FEE_STROOPS} stroops, got ${tx.fee}`);
  }
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') {
    refuse(`expected an invokeHostFunction operation, got "${op.type}"`);
  }
  const auth = (op as any).auth ?? [];
  if (auth.length !== 0) {
    refuse(
      `expected no authorisation entries — this call needs only the envelope signature, got ${auth.length}`,
    );
  }
  const hostFn = (op as any).func;
  if (hostFn.type !== 'hostFunctionTypeInvokeContract') {
    refuse('expected the host function to invoke a contract');
  }

  const call = hostFn.invokeContract;
  const fnName = call.functionName.toString();
  if (fnName !== 'mark_fiat_paid') {
    refuse(`expected function "mark_fiat_paid", got "${fnName}"`);
  }

  const contractId = Address.fromScAddress(call.contractAddress).toString();
  if (contractId !== expected.contractId) {
    refuse(`expected contract ${expected.contractId}, got ${contractId}`);
  }

  const args = call.args;
  if (args.length !== 2) {
    refuse(`expected 2 arguments to mark_fiat_paid, got ${args.length}`);
  }

  const tradeIdHex = Buffer.from(scValToNative(args[0]) as Uint8Array).toString('hex');
  if (tradeIdHex !== expected.tradeIdHex) {
    refuse(`expected trade ${expected.tradeIdHex}, got ${tradeIdHex}`);
  }

  const caller = Address.fromScVal(args[1]).toString();
  if (caller !== expected.attestor) {
    refuse(`expected caller ${expected.attestor}, got ${caller}`);
  }
}
