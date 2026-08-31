import { Address, Transaction, scValToNative, xdr } from '@stellar/stellar-sdk';

export const MAX_ATTEST_FEE_STROOPS = 10_000_000;

export interface AttestationBinding {
  contractId: string;
  tradeIdHex: string;
  attestor: string;
}

const refusal = (why: string): Error =>
  new Error(`AttestorService: refused to sign — ${why}`);

export function assertIsThisTradesAttestation(
  tx: Transaction,
  expected: AttestationBinding,
): void {
  if (tx.operations.length !== 1) {
    throw refusal(`expected exactly 1 operation, got ${tx.operations.length}`);
  }
  const fee = Number(tx.fee);
  if (!Number.isFinite(fee) || fee > MAX_ATTEST_FEE_STROOPS) {
    throw refusal(`expected a fee at or under ${MAX_ATTEST_FEE_STROOPS} stroops, got ${tx.fee}`);
  }
  const op = tx.operations[0];
  if (op.type !== 'invokeHostFunction') {
    throw refusal(`expected an invokeHostFunction operation, got "${op.type}"`);
  }
  const hostFn = op.func;
  if (hostFn.type !== 'hostFunctionTypeInvokeContract') {
    throw refusal('expected the host function to invoke a contract');
  }

  const call = hostFn.invokeContract;
  const fnName = call.functionName.toString();
  if (fnName !== 'mark_fiat_paid') {
    throw refusal(`expected function "mark_fiat_paid", got "${fnName}"`);
  }

  const contractId = Address.fromScAddress(call.contractAddress).toString();
  if (contractId !== expected.contractId) {
    throw refusal(`expected contract ${expected.contractId}, got ${contractId}`);
  }

  const args = call.args;
  if (args.length !== 2) {
    throw refusal(`expected 2 arguments to mark_fiat_paid, got ${args.length}`);
  }

  const tradeIdHex = Buffer.from(scValToNative(args[0]) as Uint8Array).toString('hex');
  if (tradeIdHex !== expected.tradeIdHex) {
    throw refusal(`expected trade ${expected.tradeIdHex}, got ${tradeIdHex}`);
  }

  const caller = Address.fromScVal(args[1]).toString();
  if (caller !== expected.attestor) {
    throw refusal(`expected caller ${expected.attestor}, got ${caller}`);
  }

  const auth = op.auth ?? [];
  if (auth.length > 1) {
    throw refusal(`expected at most 1 authorisation entry, got ${auth.length}`);
  }
  if (auth.length === 1) {
    const seen = Buffer.from(auth[0].toXdr()).toString('base64');
    const permitted = Buffer.from(sourceAccountEntryFor(call).toXdr()).toString('base64');
    if (seen !== permitted) {
      throw refusal('the authorisation entry is not the one this call implies');
    }
  }
}

function sourceAccountEntryFor(call: xdr.InvokeContractArgs): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: call.contractAddress,
          functionName: call.functionName,
          args: call.args,
        }),
      ),
      subInvocations: [],
    }),
  });
}
