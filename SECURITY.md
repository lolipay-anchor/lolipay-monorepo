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

**The coordinator never signs for a user, and never holds a user's key.** The
calls it builds for someone else to authorise — `create_trade`,
`confirm_and_release`, `raise_dispute`, `resolve`, `mark_fiat_paid` where the
recipient marks it themselves, and the staking calls `stake`, `request_unstake`,
`claim_unstake` and `slash` — are built and simulated server-side and returned as
unsigned XDR. Whichever party the contract's `require_auth` names is the party
that signs, in their own wallet. This is not every authorised call the contracts
expose — `cancel`, which needs both trade parties; `release_from_funded`, which
needs the attestor and the confirmer; and `set_config` and `set_paused` on
either contract have no builder here at all.

**The service holds three Stellar keys of its own.** This paragraph carries a date
because it has gone stale before: it described a single key, which was accurate
until the SEP-10 signer and the fiat attestor were added. All three are listed
below, with what each one can do and what the contracts refuse it. Checked against
the code and against the deployed contract's own configuration on 2026-09-10.

**A refund fee-payer.** It calls the escrow's `refund(trade_id)` on a schedule.
That function carries no `require_auth` at all, and returns the escrowed amount to
the trade's original provider and to no other address. Anyone with a funded
account could call it; this key only does it on time. The transfer is made by the
contract from its own balance, so this key needs no USDC — only the XLM it spends
on fees.

**The fiat attestor.** A depositor arriving through the SEP-24 interactive flow
has no channel to sign a Soroban call mid-session, so the anchor records on-chain
that the rupiah arrived. The escrow names one address for this in its own
configuration and accepts no other, and `set_config` refuses to change it, so the
role cannot be rotated onto another key without deploying a fresh contract. It is
bounded on every side: deposits only, only while the trade is still funded, and
only inside that trade's own deadline. It is refused as a party to any trade, and
refused as the resolver or administrator address. **It moves no money**: marking
fiat paid transfers nothing, and releasing still requires the provider's own
signature.

The contract names the attestor at two further `require_auth` sites, and neither
lets it act alone. It is a required second signature when a resolver settles a
dispute raised while a trade is still funded, and again on `release_from_funded`,
which additionally requires the provider's signature and is closed on the deployed
contract — its `early_release_providers` list is empty, so that function refuses
every provider.

**What the attestor can do, stated because it is the part that matters.** Marking
fiat paid moves a trade out of the funded state, and the permissionless refund
applies only to a funded trade. A compromised attestor therefore cannot take
anyone's money and cannot send it anywhere, but it can take a deposit off the
automatic refund path and make the provider's recovery depend on a dispute and a
resolver instead. That is a liveness cost rather than a custody one, and it is the
honest ceiling of this key.

**The SEP-10 signing key.** It signs login challenges and nothing else. Every
challenge is built with sequence number 0, which the network can never accept, so
nothing it signs on that path can reach the ledger. No contract names it, so it
carries no on-chain privilege, and the service never asks it to sign anything
else. Its public half is the `SIGNING_KEY` published in `stellar.toml`.

A fourth secret is loaded by
`services/coordinator/src/scripts/sep24-fixtures.ts`, a test-fixture
script that is not wired into the running service and is reachable only from a
developer's shell. It is named here so that a grep finding four places where a
keypair is built from a secret does not read as a contradiction of the three
above.

**No key can name a destination — not the service's, and not an operator's.** No
function that moves funds out of escrow takes a destination argument. The
destinations are fixed at `create_trade`, by the party funding it and signing for
it, and nothing afterwards can change them: the recipient, the provider, the LP
fee wallet that party named at creation, and the platform wallet, which must equal
the on-chain configuration at creation and which `set_config` refuses to change. A
resolver picks release or refund; nobody picks where. That the addresses on chain
are the ones the order describes is the field-by-field binding in the next section.

**Each key is private to the service that uses it, and each service builds the only
transaction it will sign.** No route accepts a transaction for the service to
sign. The one route that accepts a transaction at all is SEP-10's `POST /auth`,
which verifies a signature already on it and never adds one. Before signing,
**the two Soroban signers** — the refund fee-payer and the fiat attestor — check
the transaction they built against what they asked for: exactly one operation,
invoking exactly the expected function on the expected contract with the
expected trade identifier, under a fee ceiling. The attestor pins two things
beyond that: the caller argument must be the attestor's own address, and the
call must carry no authorisation entry other than the one that call itself
implies. The SEP-10 signer is outside that check — a challenge is a `manageData`
transaction with no contract call, no function and no trade identifier to bind;
what bounds it is the challenge shape SEP-10 defines, built by the SDK from the
anchor's configured home domain and web-auth domain. A missing or malformed
refund or attestor secret disables that feature rather than crashing the
service; a malformed SEP-10 key stops the service from starting, because an
anchor that cannot sign a challenge should not serve one. No key is ever logged.

**The resolver and administrator keys the contracts name are not held by the
service.** No route, job or code path can sign for them; the coordinator only
builds the transactions they would sign. They are operator keys, held by a person
— and on the current testnet deployment they live in a command-line keystore on
the same host that runs the coordinator, with the fiat attestor and the refund
fee-payer each present both in that keystore and in the service's environment.
That is a property of this deployment rather than of the design, and it is
listed under Known limitations rather than glossed over.

## Escrow guarantees

- **The confirmer must be the provider of USDC.** If the recipient could confirm,
  they could attest payment and release the counterparty's funds unilaterally.
  Self-trades are rejected. Enforced on-chain, not left to the coordinator.
  **Read this with its qualifier.** It protects the party who is waiting for
  money, and in a deposit that is the depositor. In a withdrawal the provider is
  the one being protected *and* the one holding the confirming key, so the rule
  gives the withdrawing user nothing on its own — their protection is the
  provider's staked collateral and the dispute that can slash it, not this rule.
- **The platform fee rate and the platform fee wallet are not caller-chosen.**
  Both must match on-chain config at `create_trade`, so a malicious caller cannot
  zero the platform fee or redirect it. The platform wallet is immutable —
  rotating it means deploying a fresh contract. The *LP's* fee wallet is named by
  the party creating the trade, capped by a maximum LP fee rate, and frozen on
  that trade once created.
- **The fee rate is capped**, bounding what a compromised administrator can do to
  future trades.
- **Trade windows are bounded at both ends.** A too-short window would strand a
  trade after fiat was already paid; a far-future one would block the refund path
  and trap funds indefinitely.
- **A dispute is always available while a trade is awaiting confirmation.** There
  is deliberately no window check on that path: the guarantee is that a silent
  confirmer can never freeze funds.
- **A deposit may also be disputed before any fiat is claimed, but only by the
  resolver**, because a depositor who reaches the anchor through a hosted flow
  has no channel to sign a Soroban call mid-session, whatever key they hold.
  Neither party may do this: a party
  who could would block the other's automatic refund at will. Settling such a
  dispute takes the resolver's signature *and* the attestor's, and it is not
  grounds to slash — the money is still in escrow, so releasing it is the remedy
  and a slash on top would be recovering twice.
- **Disputes raised after settlement are verdict-only, and single-shot per
  party.** No second transfer occurs: that arm of `resolve` returns before any
  token is moved. The outcome is recorded as a signal for a collateral slash and
  the prior terminal status is restored. The latch is **three independent
  latches**, one each for the provider, the recipient and the resolver, so each of
  the three can raise a post-settlement dispute once — not one per settlement.
  Nobody else may raise one at all.
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

A slash is restitution after a verdict, not a tool for use during a dispute. The
staking contract enforces, in order: the trade must have settled (a slash is
refused while the escrow still holds the principal — releasing it is the remedy
then); a post-settlement dispute must have been raised; **no verdict may still be
pending unless liability has already been established**; liability must have been
established; the slash deadline must not have passed; the named provider must be the party that ended up holding the money; and
the amount is capped at both the trade value and the provider's own bond. Funds go
to the recorded counterparty, never to a free-form address. Deduction takes from
staked collateral before unbonding collateral.

**The ordering, stated plainly because the opposite is easy to assume.** `slash`
refuses with `VerdictPending` while a dispute is open **and no liability has been
established**, and it requires the liability that `resolve` establishes. **A slash
is therefore submitted after the resolve, never before it.** An operator who
slashes first will be refused, and will then resolve away the state that would have
let the slash succeed. Once liability has been established, a later dispute may
extend the deadline but can no longer suspend the remedy — otherwise the party
found liable could freeze its own remedy by disputing again.

**How a slash is executed.** The coordinator builds an unsigned transaction and
the admin console offers it on the settlements where a provider can be the
culprit. Before building, the coordinator refuses unless the signing wallet is the
address the contract itself names as resolver or administrator. On the current
testnet deployment those two addresses are command-line keystore identities on the
coordinator's host rather than browser wallets, so a slash today is signed from
that keystore — the same limitation listed below under *Operator keys share a
host with the service today*. Recovery may be taken in parts, and the console
shows how much has already been taken — a repeated submission recovers twice, so
the running total is the thing to check before signing.

### Known limits of the bond, stated rather than implied

We would rather publish these than let the word "slashable" carry more weight than
it can hold.

- **The bond deters; it does not guarantee.** A provider's collateral is not
  reserved against the trades it backs. One bond can back several concurrent
  trades, so where a provider defaults on more than one at a time, the first
  adjudicated victim can be made whole and later ones may not be.
- **A completed unstake is final.** The exit cooldown is a fixed period, while the
  window in which a remedy can still be adjudicated depends on the dispute
  timeline and can outlast it. A provider that begins unbonding early enough can
  complete its exit before a verdict lands.
- **Pausing does not stop an exit.** The pause prevents new collateral being
  staked; it does not hold an unstake already in flight.
- **Recovery on a trade is capped at the trade value, and may be taken in parts.**
  A partial slash no longer forecloses the remainder: the contract tracks how much
  has been taken and refuses only the amount that would carry the total past the
  trade value.
- **Restitution exists only where the culprit posted collateral.** When the party
  at fault is the user rather than the provider, there is no bond to draw on. This
  is a property of who stakes, not a defect.

These are tracked as open work, not as accepted permanent behaviour.

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
- **The app's login challenge is a self-verifying token** carrying its own HMAC,
  so issuing one needs no server-side state to lose on restart, and verification
  is a constant-time comparison. Redemption does write one row — the spent nonce,
  described under Known limitations below.
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

- **Withdrawn — a login challenge is single use, on both doors.** This entry used
  to say a captured challenge and signature could be replayed until it expired.
  That was true of the app's own wallet login until 2026-08-27 and is no longer
  true of either door: the nonce is recorded on redemption, a second redemption is
  refused, and expired nonces are pruned hourly. The SEP-10 door has spent its
  nonces since it was built. The entry is corrected here rather than deleted, so a
  reader who saw the old sentence can see what replaced it.
- **Schema changes are applied at container start, from reviewed migration files.**
  Until recently the start command also carried a flag that authorised dropping
  columns and tables without asking; that is gone, and a migration that would lose
  data now stops the container instead of proceeding. Application is still
  automatic, which is normal, but a mainnet deployment should gate it behind a
  deliberate step rather than a restart.
- **Advisory locking assumes a single coordinator instance for boot-time
  seeding.** The per-trade money paths are safe across instances; the seed step is
  not guarded by a distributed lock.
- **Dispute resolution is a trusted role.** On the escrow it picks a branch, not a
  destination: funds go to the trade's own parties either way. On the staking
  contract the same key chooses the slash amount within the trade value, and a
  post-settlement dispute can be raised and adjudicated by the resolver alone —
  the second signature the pre-settlement path requires does not apply there. The
  intended mitigation is that the resolver is a multisig account. **On the current
  testnet deployment it is not**: the address the escrow names as resolver is a
  single ed25519 key with all three thresholds at zero. Making it a multisig is a
  mainnet precondition rather than a later hardening step, and until it is done
  the resolver is a single point of trust for both the branch a dispute takes and
  the amount a slash recovers.
- **Slashing depends on an operator, not on a timer.** The coordinator builds the
  transaction and the admin console offers it, but a person holding the resolver
  or administrator key must sign it — today from the command-line keystore
  described below, not from a browser wallet — after the resolve and inside the
  slash window. Nothing recovers automatically, and nothing yet alerts when that
  window opens — so the economic consequence a dispute is supposed to carry is
  only as reliable as the operator watching for it.
- **Operator keys share a host with the service today.** The resolver and
  administrator keys are not held by the coordinator, but on the current testnet
  deployment they sit in a command-line keystore on the same machine, and the
  fiat attestor and the refund fee-payer each exist both there and in the
  service's environment. The threat
  model above assumes the operator's own infrastructure is honest; that
  assumption carries more weight here than it should, and moving these keys onto
  hardware or onto a signer the service cannot reach is a mainnet precondition.
- **Administrator and resolver are separated by address, not by control.** The
  escrow refuses to let the two be the same address, and refuses to let either be
  a party to a trade; the staking contract carries no such check of its own.
  Neither stops the administrator rotating the resolver to another address it
  also holds. One person holding both keys is one party,
  whatever the configuration shows.
