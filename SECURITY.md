# Security

This document states what the system guarantees, where those guarantees are
enforced, and what it deliberately does not defend against. It is written for
someone auditing the code, not for marketing.

## Reporting a vulnerability

Please report privately rather than opening a public issue. Include what you
found, how to reproduce it, and what an attacker gains. We will confirm receipt
and keep you updated.

## Threat model

**Assumed hostile:** every request body, every uploaded file, every string a
wallet or client sends, every response from an external price source or RPC
node, and both parties to any given trade.

**Assumed honest:** the Stellar network's consensus, the Soroban runtime, and
the operator's own infrastructure.

**Out of scope:** a compromised user wallet or leaked seed. If an attacker holds
a key, they are that party. Nothing here can help.

## The non-custodial boundary

This is the property everything else rests on.

**The coordinator never signs a user's transaction.** Every fund-moving call —
`create_trade`, `mark_fiat_paid`, `confirm_and_release`, `raise_dispute`,
`resolve`, and the staking calls — is built and simulated server-side, then
returned as unsigned XDR. Whichever party the contract's `require_auth` names is
the party that signs.

**One server-side key exists, and it is a fee-payer, not a custody key.** It
automates the escrow's `refund(trade_id)`. That function is permissionless
on-chain — no `require_auth` — and can only return funds to the trade's original
provider. The key therefore cannot redirect funds, release, resolve, or dispute
anything. Anyone with a funded account could call `refund`; this just does it on
a schedule.

**That key is structurally incapable of signing anything else.** The only public
entry point builds the refund transaction itself, sourced from the key's own
public key. The generic sign-and-submit machinery is private, so no caller can
hand the key an arbitrary transaction. Before signing, a runtime assertion
rejects anything that is not exactly one operation invoking `refund`. An absent
or malformed secret disables the feature rather than crashing the service, and
the key is never logged.

## Escrow guarantees

- **The confirmer must be the provider of USDC.** If the recipient could confirm,
  they could attest payment and release the counterparty's funds unilaterally.
  Self-trades are rejected. Enforced on-chain, not left to the coordinator.
- **Fee rate and fee wallet are not caller-chosen.** Both must match on-chain
  config, so a malicious caller cannot zero the platform fee or redirect it. The
  fee wallet is immutable — rotating it means deploying a fresh contract.
- **The fee rate is capped**, bounding what a compromised administrator can do to
  future trades.
- **Trade windows are bounded at both ends.** A too-short window would strand a
  trade after fiat was already paid; a far-future one would block the refund path
  and trap funds indefinitely.
- **A dispute is always available while a trade is awaiting confirmation.** There
  is deliberately no window check on that path: the guarantee is that a silent
  confirmer can never freeze funds.
- **Disputes raised after settlement are verdict-only and single-shot.** No second
  transfer occurs; the outcome is recorded as a signal for a collateral slash, the
  prior terminal status is restored, and a latch prevents the same settlement
  being re-disputed.
- **A resolver picks a branch, never a destination.** Release or refund — every
  address is the one snapshotted at trade creation. If the resolver stays silent
  past a deadline, an administrator may step in, under the same restriction, so a
  disputed trade cannot be locked forever.
- **State is written before tokens move**, on every fund-moving path.
- **The settlement token is snapshotted per trade**, so changing the default
  cannot strand funds already in flight.
- **Storage lifetimes exceed the maximum trade lifetime with margin.** An expired
  ledger entry would strand escrowed funds, so every mutating call also extends
  the contract's own instance entry.

## Binding the escrow to the order

A trade identifier alone is not evidence. The contract deliberately does not know
about orders, so it accepts an amount, a recipient, a provider wallet and a set of
deadlines from whoever calls it, checking only that they are internally coherent.
Treating the mere existence of a trade with a matching identifier as proof that the
escrow holds what the order describes would let a provider fund one base unit and
still have the counterparty told to pay in full.

**So an on-chain trade may not advance an order until it has been compared against
it, field by field.** Fourteen values must match exactly: both amounts, the
currency, the direction, all three party roles, both wallets, both fee rates and
all three deadlines. The roles are derived from the direction, so a deposit and a
withdrawal are each checked with their own parties in their own positions.

**A value that cannot be decoded counts as a mismatch, never as a value to skip.**
A response carrying only a status produces fourteen violations rather than passing,
so a decoder broken by a library upgrade or a contract change refuses to bind
instead of silently accepting what it could not read.

Every path that can advance an order from its off-chain state performs this check —
event ingestion, the refresh behind a status read, the provider's assignment list,
and the refresh that runs before a cancellation. On a mismatch nothing happens: the
order does not advance, no notification is sent, and payment instructions stay
hidden. The mismatching fields are logged. The escrow in question holds only the
submitter's own funds and the permissionless refund path returns them.

Once an order legitimately holds an on-chain status the binding is settled and is
not re-checked; the compared values cannot change, because the contract refuses a
second creation for the same identifier.

## Collateral and slashing

A slash is bound to a genuinely disputed trade. The trade must actually be in
dispute, the provider must be a party to it, funds go to the recorded
counterparty rather than a free-form address, the amount is capped at the trade
value, and each trade can be slashed once. Disputed status is read live, so a
resolved trade cannot be slashed. Deduction takes from staked collateral before
unbonding collateral, so a provider cannot escape by moving funds into cooldown.

## Concurrency

Two patterns carry the load, and both are load-bearing rather than stylistic.

**Guarded writes.** Every state transition re-checks its precondition at write
time, not merely at an earlier read. Losing that race surfaces as a conflict and
leaves the row exactly as the concurrent writer left it. This is what makes two
providers racing to claim the same order safe, and what prevents a concurrent
cancellation being silently overwritten.

**Per-user advisory locking.** Daily limits are enforced inside a database
transaction holding a per-address advisory lock, with the running total re-read
under that lock immediately before the order is written. A check performed before
that point is advisory only — without the locked re-read, concurrent requests
could each pass and together exceed the cap.

Notifications fire only when the guarded write actually applied, so a transition
that lost its race cannot emit a phantom event.

## Trust boundaries on input

- **Uploaded files are identified by magic bytes.** The client-declared
  content type is never trusted for storage or serving decisions; it is compared
  against the detected type purely as a tripwire, and any mismatch is rejected
  rather than corrected.
- **Object keys are server-derived.** Path traversal is structurally impossible:
  the only inputs are a server-controlled constant and either a generated UUID or
  a fixed two-value role.
- **Files are served download-only, through the application.** No presigned or
  direct storage URL is ever issued, so the authorisation check cannot be
  bypassed. Responses set a content type derived from the server's own detection,
  disable MIME sniffing, force attachment disposition, and apply a restrictive
  content security policy — before any bytes are piped.
- **Dispute evidence is attribution-checked.** A party cannot attach another
  party's file, because the role and order are both server-derived.
- **Unknown request properties are rejected**, not silently stripped.

## Authentication and authorisation

- **Roles are re-derived from the database on every authenticated request.** The
  role claim inside a token is deliberately ignored, so a suspended provider
  loses access immediately and a newly approved one gains it without re-issuing
  anything.
- **The signature algorithm is pinned** everywhere a token is verified, rather
  than trusting the algorithm a token claims for itself.
- **The login challenge is a self-verifying token** carrying its own HMAC, so
  there is no server-side store to lose on restart, and verification is a
  constant-time comparison.
- **Payment instructions are never included in list responses**, and are revealed
  only to the party who must pay, only once funds are actually escrowed.
- **The realtime channel is read-only.** It accepts no command that moves funds
  or changes state, rejects unauthenticated sockets, authorises room membership
  server-side on every join, and carries minimal payloads — never payment
  details. A failed join returns one generic reason, so an authenticated socket
  cannot use it to discover which order identifiers exist.

## Failure posture

Fail-closed where a wrong answer moves money: an unverifiable provider stake is
not matchable; a price that fails plausibility bounds is refused rather than
quoted; a scheduled refund requires a fresh on-chain read confirming the trade is
still awaiting payment; a corridor disabled after a quote was issued cannot be
smuggled into an order.

Fail-open only where a wrong answer merely inconveniences: a transient outage
checking whether an address can receive the asset does not block a trade, because
the transfer would fail loudly anyway if it were genuinely missing.

Absolute plausibility bounds are applied to every accepted price regardless of
source, so a single manipulated response cannot produce a garbage rate. A price
that deviates too far from the last known value for that corridor is rejected,
and that allowance is kept strictly below the platform spread so one accepted
anomaly cannot consume the entire cushion on a binding lock.

## Known limitations

Stated plainly rather than omitted.

- **A captured login challenge and signature can be replayed until it expires.**
  It only re-issues a session for the address the signer already controls, so it
  grants no impersonation, but strict single use would require a replay store.
- **Schema changes are currently applied automatically at container start.** This
  is appropriate for testnet and must become a reviewed, gated migration before
  any mainnet deployment.
- **Advisory locking assumes a single coordinator instance for boot-time
  seeding.** The per-trade money paths are safe across instances; the seed step is
  not guarded by a distributed lock.
- **Dispute resolution is a trusted role.** It cannot redirect funds, but it does
  decide outcomes.
