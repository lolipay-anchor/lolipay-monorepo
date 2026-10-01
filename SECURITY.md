# Security

This document states what the system guarantees, where those guarantees are
enforced, and what it deliberately does not defend against. It is written for
someone auditing the code, not for marketing.

Where it cites a line, the line is in `main` at commit `495f408`, the commit
deployed on 2026-09-30. Where it cites a chain fact, the fact was read from the
deployed contracts' own configuration on 2026-09-30.

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting on this
repository: under the repository's security tab, choose **Report a
vulnerability**. Do not open a public issue. Include what you found, how to
reproduce it, and what an attacker gains.

## Threat model

**Assumed hostile:** every request body, every uploaded file, every string a
wallet or client sends, every response from an external price source or RPC
node, and both parties to any given trade.

**Assumed honest:** the Stellar network's consensus, the Soroban runtime, and
the operator's own infrastructure. **On the current deployment that last
assumption carries the entire custody claim**, and that infrastructure includes
the four public web frontends, for the reasons stated under *One keystore holds
every operator role today* below.

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
that signs, in their own wallet. In the SEP-24 interactive flow the signed
transaction is submitted from the browser straight to the Soroban RPC endpoint
and never passes through the coordinator. This is not every authorised call the
contracts expose — `cancel`, which needs both trade parties; `release_from_funded`,
which needs the attestor and the confirmer; and `set_config` and `set_paused` on
either contract have no builder here at all.

**The service holds three Stellar keys of its own.** This paragraph carries a date
because it has gone stale before: it described a single key, which was accurate
until the SEP-10 signer and the fiat attestor were added. All three are listed
below, with what each one can do and what the contracts refuse it. Checked against
the code and against the deployed contracts' own configuration on 2026-09-30, and
against the running container by name: `ATTESTOR_SECRET`, `REFUND_SIGNER_SECRET`
and `SEP10_SIGNING_KEY` are present, `ADMIN_SECRET` and `RESOLVER_SECRET` are not.

**A refund fee-payer.** It calls the escrow's `refund(trade_id)` on a schedule.
That function carries no `require_auth` at all, and returns the escrowed amount to
the account that funded it — the liquidity provider on a deposit, the user on a
withdrawal — and to no other address. Anyone with a funded account could call it;
this key only does it on time. The transfer is made by the contract from its own
balance, so this key needs no USDC — only the XLM it spends on fees.

**The fiat attestor.** A depositor arriving through the SEP-24 interactive flow
has no channel to sign a Soroban call mid-session, so the anchor's attestor marks
the deposit as paid on chain. It observes no bank. **It signs on two triggers,
and neither is a wallet-signed Soroban call** (corrected 2026-09-30; this entry
used to say the anchor "records that the rupiah arrived"):

- the provider's wallet-signed receipt, `POST /orders/:id/confirm-receipt`
  (`src/admin/provider-receipt.controller.ts`, then
  `confirmReceiptAsProvider` in `src/admin/admin.service.ts`). The receipt is a
  SEP-53 message over the order, trade id, amount, currency, reference and time,
  checked for freshness against the challenge TTL, made single-use through the
  spent-nonce table, matched against the order's provider in the database **and**
  against `usdc_provider` read fresh from the chain, accepted only for a deposit
  that is still funded on chain, and serialised per order — and only then does
  the attestor's own guard see the transaction it built;
- an administrator's attestation, `POST /admin/orders/:id/attest`
  (`src/admin/admin.controller.ts`), which needs an administrator **session
  token alone** — no per-action signature. It remains as the rescue path and is
  the weaker of the two triggers. That is a known gap, not a design choice.

The escrow names one address for this role in its own configuration and accepts
no other, and `set_config` refuses to change it, so the role cannot be rotated
onto another key without deploying a fresh contract. It is bounded on every side:
deposits only, only while the trade is still funded, and only inside that trade's
own deadline. It is refused as a party to any trade, and refused as the resolver
or administrator address. **It moves no money**: marking fiat paid transfers
nothing, and releasing still requires the provider's own signature — *per key*.
What the host that holds it can do is a separate question, answered below.

The contract names the attestor at two further `require_auth` sites, and neither
lets it act alone. It is a required second signature when a resolver settles a
dispute raised while a trade is still funded — except on the administrator's
post-deadline refund of such a dispute, which needs no attestor — and again on
`release_from_funded`, which additionally requires the provider's signature and
is closed on the deployed contract: its `early_release_providers` list is empty,
so that function refuses every provider.

**What the attestor can do, stated because it is the part that matters.** Marking
fiat paid moves a trade out of the funded state, and the permissionless refund
applies only to a funded trade. A compromised attestor *key* therefore cannot
take anyone's money and cannot send it anywhere, but it can take a deposit off
the automatic refund path and make the provider's recovery depend on a dispute
and a resolver instead. That is a liveness cost rather than a custody one, and it
is the honest ceiling of this key **on its own**. It is not the ceiling of the
keystore that holds it.

**The SEP-10 signing key.** It signs login challenges and nothing else. Every
challenge is built with sequence number 0, which the network can never accept, so
nothing it signs on that path can reach the ledger. No contract names it, so it
carries no on-chain privilege, and the service never asks it to sign anything
else. Its public half is the `SIGNING_KEY` published in `stellar.toml`. It is
held in the service's environment — which on the host is the coordinator's
environment file, also copied into the host's encrypted backups — and not in the
host keystore: the identity the host keystore labels as its SEP-10 key is a
different key from the published one.

**Two tracked scripts can build a keypair from any identity in the host
keystore** (corrected 2026-09-30; this entry used to name one script and "a
fourth secret"). `src/scripts/sep24-fixtures.ts` and
`src/scripts/lp-activate-payment-method.ts` both run `stellar keys secret <name>`
and are reachable only from a shell on the host, not from the running service.
On this host that keystore includes the administrator and resolver identities, so
a shell on the host is a shell that can sign as either. A grep for
`Keypair.fromSecret` finds five sites — the three service keys above and these
two scripts. No queue item exists for this yet; it is named here so that it is
not discovered.

**No key can name a destination — not the service's, and not an operator's.** No
function that moves funds out of escrow takes a destination argument. The
destinations are fixed at `create_trade` and nothing afterwards can change them:
the recipient, the provider, the LP fee wallet, and the platform wallet, which
must equal the on-chain configuration at creation and which `set_config` refuses
to change. A resolver picks release or refund; nobody picks where. That the
addresses on chain are the ones the order describes is the field-by-field binding
in the next section. **One of those fixed addresses is chosen by the coordinator,
not by a party** (corrected 2026-09-30; this entry used to say the party named
it): the LP fee wallet is composed into the transaction by the coordinator from
the provider's registered address (`src/order/order.service.ts:258`,
`src/order/order-tx.service.ts:138`) and `create_trade` accepts it as given —
it caps the LP fee *rate* at 5% and validates the *address* not at all. Up to 5%
of every trade therefore goes wherever the transaction's composer says. The
provider signs the transaction and can read it, and today the composer is the
service; if the host is what is compromised, this is theft. Open as internal
queue item 527.

**The service holds only the keys it uses, and each builds the only transaction
it will sign** (corrected 2026-09-30; this entry used to say each key was private
to the service, which the keystore paragraph below contradicts). No route accepts
a transaction for the service to sign. The one route that accepts a transaction
at all is SEP-10's `POST /auth`, which verifies a signature already on it and
never adds one. Before signing, **the two Soroban signers** — the refund fee-payer
and the fiat attestor — check the transaction they built against what they asked
for: exactly one operation, invoking exactly the expected function on the
expected contract with the expected trade identifier, under a fee ceiling. The
attestor pins two things beyond that: the caller argument must be the attestor's
own address, and the call must carry no authorisation entry other than the one
that call itself implies. The SEP-10 signer is outside that check — a challenge
is a `manageData` transaction with no contract call, no function and no trade
identifier to bind; what bounds it is the challenge shape SEP-10 defines, built
by the SDK from the anchor's configured home domain and web-auth domain. A
missing or malformed refund or attestor secret disables that feature rather than
crashing the service; a malformed SEP-10 key stops the service from starting,
because an anchor that cannot sign a challenge should not serve one — while an
absent one lets it start and answer `GET /auth` with 503. No key is ever logged.

**The resolver and administrator keys the contracts name are not held by the
service.** No route, job or code path *in the service* can sign for them; the
coordinator only builds the transactions they would sign. They are operator keys,
held by a person — and on the current testnet deployment they live in a
command-line keystore on the same host that runs the coordinator, beside the fiat
attestor and the refund fee-payer, which are each present both in that keystore
and in the service's environment. The two scripts named above can load any of
them from a host shell. What that means in full is the first entry under Known
limitations, and it is the most important sentence in this document.

## Escrow guarantees

- **The confirmer must be the provider of USDC.** If the recipient could confirm,
  they could attest payment and release the counterparty's funds unilaterally.
  Self-trades are rejected. Enforced on-chain, not left to the coordinator.
  **Read this with its qualifier** (corrected 2026-10-01; this entry used to say
  the rule protects the depositor on a deposit and the provider on a withdrawal,
  which is both directions inverted). It protects whoever put up the USDC — the
  liquidity provider on a deposit, the withdrawing user on a withdrawal. It gives
  nothing to the party who sends rupiah first and then waits for that
  confirmation: the depositor on a deposit, the liquidity provider on a
  withdrawal. Once that party has paid, the release needs the other side's
  signature alone. While the trade has not been marked paid, the permissionless
  `refund` returns the USDC to whoever funded it once the refund window opens,
  and the refund fee-payer submits that refund on a schedule when automatic
  refunds are on, whether or not a depositor has told the anchor they paid. What
  remains to the waiting party is a dispute — the entries below say who may raise
  one and when — and, after a deposit has settled, a verdict that the settlement
  was wrong, which is what a slash of the provider's collateral needs.
- **The platform fee rate and the platform fee wallet are not caller-chosen.**
  Both must match on-chain config at `create_trade`, so a malicious caller cannot
  zero the platform fee or redirect it. The platform wallet is immutable —
  rotating it means deploying a fresh contract. The *LP's* fee wallet is
  composed by the coordinator as described above, capped by a maximum LP fee
  rate, and frozen on that trade once created.
- **The fee rate is capped**, bounding what a compromised administrator can do to
  future trades.
- **Trade windows are bounded at both ends.** A too-short window would strand a
  trade after fiat was already paid; a far-future one would block the refund path
  and trap funds indefinitely.
- **A dispute is always available while a trade is awaiting confirmation.** There
  is deliberately no window check on that path: the guarantee is that a silent
  confirmer can never freeze funds. **Its converse is a gap, stated here:** a
  customer has no unilateral exit from that state. Once a trade is marked paid,
  `refund` refuses (it requires the funded state), `resolve` refuses both parties,
  and nothing deadlines the dispute's resolution — only the resolver, or the
  administrator after the resolver's deadline, can settle it. **On a withdrawal
  the provider can put a trade into that state alone** — one signature, no
  evidence, whether or not it sent the rupiah — and from then the user's USDC
  leaves escrow only through the user's own release or through lolipay's
  resolver. On a deposit, a provider who confirms receipt, so that the attestor
  marks the trade paid, and then withholds the release strands the depositor the
  same way. Open as internal queue item 515.
- **A deposit may also be disputed before any fiat is claimed, but only by the
  resolver**, because a depositor who reaches the anchor through a hosted flow
  has no channel to sign a Soroban call mid-session, whatever key they hold.
  Neither party may do this: a party
  who could would block the other's automatic refund at will. Settling such a
  dispute takes the resolver's signature *and* the attestor's — except the
  administrator's post-deadline refund, which takes the administrator's alone —
  and it is not grounds to slash — the money is still in escrow, so releasing it
  is the remedy and a slash on top would be recovering twice.
- **Disputes raised after settlement are verdict-only, and single-shot per
  party.** No second transfer occurs: that arm of `resolve` returns before any
  token is moved. The outcome is recorded and the prior terminal status is
  restored; the verdict sets liability, which a collateral slash needs, only when
  it contradicts the prior outcome (corrected 2026-10-01; this entry used to say
  the outcome is recorded as a signal for a collateral slash). The latch is
  **three independent
  latches**, one each for the provider, the recipient and the resolver, so each of
  the three can raise a post-settlement dispute once — not one per settlement.
  Nobody else may raise one at all. **That arm requires the resolver's signature
  and no other**: the attestor co-signs only the pre-settlement arm.
- **A resolver picks a branch, never a destination.** Release or refund — every
  address is the one snapshotted at trade creation. If the resolver stays silent
  past a deadline, an administrator may step in, under the same restriction, so a
  disputed trade cannot be locked forever.
- **State is written before tokens move**, on every fund-moving path.
- **The settlement token is snapshotted per trade**, so changing the default
  cannot strand funds already in flight.
- **Storage lifetimes exceed the maximum trade lifetime with margin.** An expired
  ledger entry would strand escrowed funds, so every call that can move or
  dispute a trade also extends the contract's own instance entry; `set_config`
  and `set_paused` do not.

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
that keystore — the same limitation listed below under *One keystore holds every
operator role today*. Recovery may be taken in parts, and the console
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

**Per-person advisory locking.** Daily limits are enforced inside a database
transaction holding an advisory lock keyed on the verified person, not on the
address, with the running total re-read under that lock immediately before the
order is written. A check performed before that point is advisory only — without
the locked re-read, concurrent requests could each pass and together exceed the
cap.

Notifications fire only when the guarded write actually applied, so a transition
that lost its race cannot emit a phantom event.

## Trust boundaries on input

- **Uploaded files are identified by magic bytes.** The client-declared
  content type is never trusted for storage or serving decisions; it is compared
  against the detected type purely as a tripwire, and any mismatch is rejected
  rather than corrected.
- **Object keys are server-derived.** Path traversal is structurally impossible:
  every input to a key is server-controlled — a constant, a generated UUID, a
  fixed two-value role, or a server-side timestamp.
- **Files are served download-only, through the application.** No presigned or
  direct storage URL is ever issued, so the authorisation check cannot be
  bypassed. Responses set a content type derived from the server's own detection,
  disable MIME sniffing, force attachment disposition, and apply a restrictive
  content security policy — before any bytes are piped.
- **Dispute evidence is attribution-checked.** A party cannot attach another
  party's file, because the role and order are both server-derived.
- **Unknown request properties are rejected**, not silently stripped.
- **A pasted Stellar secret seed is refused as a payment destination — on the
  server only.** The guard is one regex, in `src/order/payment-destination.ts`,
  applied wherever a payment destination is entered — a provider's payment
  method, and the bank account on a withdrawal opened in lolipay's app or through
  SEP-24; nothing in the frontend apps or shared packages carries it, so a pasted
  seed crosses the network before it is refused. Open as internal queue item 530.
- **Cross-origin policy is fail-to-ours, not fail-closed.** The allowlist for
  the app routes is the `CORS_ORIGINS` environment value unioned with lolipay's
  own four production origins, built into the code, so the "no origin at all"
  branch is unreachable in production; the SEP endpoints are served with
  `origin: *` by design, as SEP-10 and SEP-24 require. This document said nothing
  about CORS until 2026-09-30, and the project's internal invariant list still says
  "closed by default"; correcting that list is internal queue items 496 and 532.

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
- **Through the API, payment instructions are revealed only to the party who
  must pay, only once funds are actually escrowed, and only while the identity of
  the order's user — the depositor or the withdrawing user — is verified**
  (corrected 2026-09-30; this entry used to say they never appear in a list
  response). On a deposit that is the payer's own identity; no provider's
  identity is checked on this path. The user's order list carries none. The
  provider's assignment list, `GET /lp/assignments`, does carry them for the
  trades on which that provider is the payer — withdrawals — under the same
  conditions, and only while the provider is approved. **The SEP-24 status page
  is the exception:** `GET /sep24/more-info/:id`, a deposit's `more_info_url`,
  takes no credential and shows the provider's payment details, the amount and
  the reference to anyone who opens it, while the deposit is funded, inside its
  pay window and not yet reported paid. Its identifier is a random UUID, so the
  link itself is the credential.
- **A provider's payment methods can be rewritten by whoever holds that
  provider's session token.** `POST`, `PATCH` and `DELETE /lp/payment-methods`
  need a session token with the provider role and no wallet signature, and the
  provider console keeps that token in `sessionStorage`. A stolen provider
  session can therefore change where depositors are told to send rupiah — a
  larger reach than the receipt route, which does require a wallet signature.
  Open as internal queue item 568.
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

**The trustline check is fail-closed too** (corrected 2026-09-30; this entry used
to say a transient outage checking whether an address can receive the asset does
not block a trade). Since 2026-08-25 a trustline the service could not check is
treated as a trustline it does not have: the read raises a service-unavailable
error and the order is refused until the check can be made. A false "no
trustline" would send USDC to an address that cannot hold it, so the
inconvenience was judged the cheaper failure.

Absolute plausibility bounds are applied to every accepted price regardless of
source, so a single manipulated response cannot produce a garbage rate. A price
that deviates too far from the last known value for that corridor is rejected,
and that allowance is kept strictly below the platform spread so one accepted
anomaly cannot consume the entire cushion on a binding lock.

## Known limitations

Stated plainly rather than omitted.

- **One keystore holds every operator role today, so address separation is not
  custody separation.** The escrow refuses a configuration in which the
  administrator, resolver and fiat attestor are the same address
  (`contracts/escrow/src/lib.rs:60`, `:98-100`); nothing anywhere makes them
  *differently held*. On the current deployment all three are identities in one
  command-line keystore on the host that runs the coordinator, beside the refund
  fee-payer, and the attestor and refund keys are also in the service's
  environment. Each of the three operator accounts is a single ed25519 signer
  with all thresholds at zero (Horizon, 2026-09-30). **Controlling that host
  takes less than the phrase suggests.** The keystore belongs to one non-root
  operating-system account, and the coordinator's environment file — the
  attestor, refund and SEP-10 secrets and the session token secret — sits in that
  account's working tree. The same account runs the four public web frontends and
  is in the `docker` group, which is root-equivalent, so code execution in any
  public frontend reaches every operator key and the session secret, and an
  arbitrary file read there reaches both the keystore and that environment
  file. Whoever controls that host
  therefore controls every privileged role at once, and at the contracts that is
  enough to move or take money:
  - on a deposit, the attestor marks it paid (`mark_fiat_paid`, `:273`), the
    resolver raises a dispute from the paid state (`raise_dispute`, `:416`,
    `:452`) and resolves it as a release (`resolve`, `:498`, `:540-563`) — the
    escrowed USDC goes to the depositor's address with no party's signature after
    funding;
  - on any trade already marked paid, in either direction, the resolver alone
    settles it either way; that arm needs no second key;
  - the administrator may appoint any resolver through `set_config`
    (`:83-115`), and the staking contract's `slash` accepts the administrator as
    well as the resolver (`contracts/staking/src/lib.rs:218`);
  - a post-settlement verdict against the provider needs only the resolver's
    signature — that arm of `resolve` (`:508-536`) requires no attestor and sets
    liability whenever the verdict contradicts the prior outcome — and `slash`
    then pays the trade's recorded counterparty from the provider's bond
    (`:247-251`, `:281`). A counterparty who opened a deposit, never paid, let the
    permissionless refund run, and then obtained a resolver's verdict against the
    provider would be paid from the provider's collateral. Pausing either
    contract closes none of this: `resolve` and `slash` do not read the pause
    flag, and the pause itself is the administrator's.

  Every two-signature sentence above is true per key and does not bound what
  this host can do. The attestor cannot be rotated without redeploying the escrow
  (`:92-94`). The threat model's honest-infrastructure assumption carries all of
  this. Moving these keys onto separately controlled signers — hardware, or a
  signer the service cannot reach — is a mainnet precondition, and the finding is
  open as internal queue item 514.
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
  single ed25519 key with all three thresholds at zero, and so are the
  administrator and the attestor. Making it a multisig is a
  mainnet precondition rather than a later hardening step, and until it is done
  the resolver is a single point of trust for both the branch a dispute takes and
  the amount a slash recovers.
- **Slashing depends on an operator, not on a timer.** The coordinator builds the
  transaction and the admin console offers it, but a person holding the resolver
  or administrator key must sign it — today from the command-line keystore
  described above, not from a browser wallet — after the resolve and inside the
  slash window. Nothing recovers automatically. **An alert does fire when that
  window opens** (corrected 2026-09-30; this entry used to say nothing alerted):
  the monitoring service checks every five minutes and raises `slash_window_open`
  through the alert outbox, and since 2026-09-30 it also raises
  `attestation_failed` and `attestor_balance_low`. The economic consequence a
  dispute is supposed to carry is still only as reliable as the operator who acts
  on the alert.
- **Administrator and resolver are separated by address, not by control.** The
  escrow refuses to let the two be the same address, and refuses to let either be
  a party to a trade; the staking contract carries no such check of its own.
  Neither stops the administrator rotating the resolver to another address it
  also holds. One person holding both keys is one party,
  whatever the configuration shows — and on this deployment, per the first entry
  above, one keystore does.
- **The service holds other credentials that are not Stellar keys, and rotating
  them is open work.** Present in the running container by name: the session
  token secret, the verification provider's API key and webhook secret, the email
  provider's API key, the alert webhook URL (which is bearer-equivalent), the
  database password and the object store credentials. `STELLAR_READ_KEY` is a
  public address, not a secret. **The session token secret is the widest of
  them for money.** App sessions are stateless tokens and the role is re-derived
  from the address inside one, so whoever holds the session token secret can mint a
  working session for
  any administrator or provider address that has signed in before — and with it
  make the attestor mark any funded deposit paid through the administrator's
  attestation route, approve, suspend or revoke providers, change the platform
  configuration and corridors, and rewrite every provider's payment destination.
  The same secret also signs every SEP-10 token and every SEP-24 interactive
  credential, so it can act as any user who has signed in before, in the app and
  at those doors, including naming the bank account a SEP-24 withdrawal will be
  paid to, if they submit it before the withdrawing user does.
  There is no server-side session to revoke. The administrator console, like the
  provider console, keeps its token in `sessionStorage`. For personal data the
  verification provider's API key reaches further, because it lists the bound
  application's verification sessions and retrieves any session's record from the
  provider, with no identifier from lolipay's database needed. The provider's
  webhook secret can make the identity of any signed-in account that has not been
  refused read as accepted and screened, provided the delivery names the
  verification session that account is following, if any; its API key may do the
  same through a status change at the provider. Rotation of the secrets
  that can be rotated is internal queue item 7 and has not been done; the
  attestor seed is excluded from it because the escrow pins that key, so it can
  only be replaced by redeploying the escrow.
