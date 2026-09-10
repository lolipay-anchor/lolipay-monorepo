# Non-custodial anchor status mapping

How a peer-to-peer settlement engine is presented through SEP-24, what the protocol can express about
it, and — the part most specifications leave out — what it cannot.

**Scope.** lolipay is a SEP-1 / SEP-10 / SEP-12 / SEP-24 anchor for the Indonesian rupiah ⇄ USDC
corridor on Stellar, currently on **testnet**. Deposit and withdrawal directions only.

**Versions this maps to.** SEP-24 **v3.8.0** and the transaction schema of
`@stellar/anchor-tests`. Both matter: §7 shows one place where the protocol's vocabulary and the
acceptance suite's enum have diverged, and the mapping follows the suite.

---

## 1. Why this mapping is not obvious

A conventional SEP-24 anchor is the counterparty. It receives the user's fiat into its own bank
account, holds it, and sends its own USDC. SEP-24's vocabulary is built for that shape: the states
describe a conversation between one user and one anchor.

lolipay is not the counterparty. Each trade is matched to an independent liquidity provider, and the
USDC is locked in a Soroban escrow contract for that trade alone. The anchor holds no user balance at
any point — there is no omnibus account.

That difference produces states SEP-24 has no words for, and the honest thing is to name them rather
than round them off to the nearest protocol status. §7 does that, and §3 and §4 state exactly how far
the operator's own keys reach, because a specification that describes only the mechanism and not the
authority over it is incomplete.

**A note on the word "provider".** In the contract, `usdc_provider` is whoever funds the escrow. On a
**deposit** that is the liquidity provider; on a **withdrawal** it is **the user**. Where this
document means the liquidity provider it says so.

---

## 2. Settlement is per-trade escrow

`create_trade` locks the `usdc_provider`'s USDC and writes `Status::Funded` in the same invocation
(`contracts/escrow/src/lib.rs`). There is no pre-funded state. The USDC leaves only along one of five
paths:

| Path | Who can call it | Effect |
|---|---|---|
| `confirm_and_release` | the `usdc_provider` — the contract forces `confirmer == usdc_provider` | releases to the recipient |
| `release_from_funded` | the fiat attestor **and** the confirmer, both signing | releases to the recipient before fiat confirmation |
| `refund` | **permissionless** once the deadline passes — no signature at all | returns the USDC to the `usdc_provider` |
| `cancel` | the `usdc_provider` **and** the recipient, both signing, while still `Funded` | refunds the `usdc_provider` |
| `resolve` | the resolver; or the admin once the resolver's window elapses | settles a disputed trade in one direction |

Two things about that table are easy to misread and are worth stating outright.

**The confirmer is always the party who *receives* the fiat, not the one who paid it.** The contract
forces `confirmer == usdc_provider`, and the `usdc_provider` is by construction the side that put up
USDC and is owed money. On a deposit the liquidity provider confirms that the user's rupiah arrived;
on a withdrawal the user confirms that the provider's rupiah arrived.

**`release_from_funded` is closed by configuration, not by the code.** `early_release_providers` is
`[]` on the deployed instance, and the function refuses every provider while that is true. It is a
configuration value the admin can change, so this document reports it as configuration rather than as
a property of the contract.

**The coordinator's `CANCELLED` order state is unrelated to the contract's `cancel`.** On-chain
`cancel` produces `Refunded`. The coordinator's `CANCELLED` is a pre-escrow state — see §7.

The on-chain state machine is five states — `Funded`, `FiatPaid`, `Released`, `Refunded`, `Disputed`.
The coordinator's order record carries a wider set that includes states existing before anything is
on chain.

---

## 3. Fiat receipt is attested, and the attestor's reach is bounded but not trivial

Neither the contract nor the anchor can observe an Indonesian bank transfer. Something must assert
that the rupiah arrived, and here that assertion is a **signature**.

`mark_fiat_paid` accepts **two** callers, and which one it is changes both the authority and the
deadline:

- **the fiat attestor**, a dedicated key held by the operator — **on a deposit only**. Its deadline is
  `min(confirm_deadline, pay_deadline + 3,600 s)`, so it retains a grace period after the user's own
  window to pay has closed.
- **the trade's recipient**, in either direction. On a **withdrawal there is no attestor branch at
  all**: the only caller is the recipient, who is the liquidity provider — so on that side the
  provider asserts on chain that it sent the rupiah, about itself.

The attestor is also a required co-signature on two other paths, and a specification that omitted them
would be misleading:

- **`release_from_funded`** requires the attestor **and** the confirmer. It moves USDC to the
  recipient. Closed today by `early_release_providers = []`.
- **`resolve`, on a trade disputed while still `Funded`**, requires the attestor's signature unless
  the call is the admin's post-deadline refund.

**What the attestor can and cannot do, precisely.** It **acts alone on exactly one transition** —
`Funded → FiatPaid`, on a deposit — and `mark_fiat_paid` requires that single signature and no other.
On **both paths where USDC actually moves**, a second and different key must also sign. It cannot
choose a destination: every address a release pays is fixed when the trade is created.

**The attestor key cannot be replaced after construction.** `set_config` refuses any change to
`fiat_attestor`, and refuses any change to the platform fee destination. Rotating either means
redeploying the contract, not editing configuration — which bounds the `early_release_providers`
caveat above: that list is admin-changeable, these two are not.

**The contract enforces separation between the three operator keys.** Both the constructor and
`set_config` refuse a configuration where `admin`, `resolver` and `fiat_attestor` are not three
distinct addresses, and `create_trade` refuses to create a trade whose parties include any of them.

---

## 4. Recourse is operator-mediated, and the operator can open it

`raise_dispute` is authorised as follows, and the asymmetry is deliberate:

- **From `Funded`** — only the **resolver** may raise. A party to the trade is refused. This case is
  deposit-only and bounded by the trade's dispute deadline.
- **From `FiatPaid`, `Released` or `Refunded`** — either party **or** the resolver may raise. Those
  three plus `Funded` are the whole domain: a trade already `Disputed` cannot be re-raised.

`resolve` is restricted to the resolver, or to the admin once the resolver's window has elapsed. A
resolver who is a party to the trade is refused, and such a trade cannot be created in the first
place.

**The windows, with the numbers.** These are the **contract's bounds**; the coordinator chooses each
trade's actual deadlines inside them, and its defaults are tighter (a 1,800 s pay window and a
1,800 s confirm window on the deployed configuration).

| Window | Value |
|---|---|
| resolver window | 86,400 s (24 h) |
| post-verdict grace | 86,400 s |
| dispute window | configurable 3,600–86,400 s; **86,400 s deployed** |
| pay window | 600–86,400 s |
| total trade window | ≤ 2,592,000 s (30 days) |
| attest grace | 3,600 s |

**Recourse is bounded in count as well as in time.** Each of the provider, the recipient and the
resolver may open **exactly one** post-settlement dispute per trade; a second is refused.

---

## 5. Two directions, two orderings

**Deposit (rupiah → USDC).** The liquidity provider funds the escrow first. The user then pays rupiah
to the provider's bank account, and the provider confirms receipt to release the USDC.

**Withdrawal (USDC → rupiah).** The user funds the escrow with their own signature — the user is the
`usdc_provider` here — and the liquidity provider pays rupiah out of their own bank account. The user
confirms receipt.

The escrow is the same contract in both directions. **The recourse paths differ in one respect** — a
dispute raised while the trade is still `Funded` is deposit-only, per §4 — and fiat attestation
differs as described in §3. What else differs is **who parts with value first**, and therefore who is
waiting. On a withdrawal that is the user. A wallet offering both
directions should not present them as equivalent.

---

## 6. The status mapping

An order's SEP-24 status is derived, never stored twice. The function is
`services/coordinator/src/sep24/sep24-status.ts`, and it is the single source of this table.

### Deposit

| Order state | SEP-24 status | What is actually happening |
|---|---|---|
| no order yet | `incomplete` | the interactive flow has not produced an order |
| `CREATED` | `pending_anchor` | a quote exists; no provider is committed |
| `MATCHED` | `pending_anchor` | a provider is committed; the escrow is not funded |
| `AWAITING_ONCHAIN` | `pending_anchor` | the funding transaction is in flight |
| `FUNDED` | `pending_user_transfer_start` | the USDC is locked; the user must now send rupiah |
| `FIAT_PAID` | `pending_anchor` | the rupiah is attested; release is pending |
| `RELEASED` | `completed` | the USDC has been released on chain |
| `REFUNDED` | `refunded` | the escrow returned the USDC to the `usdc_provider` |
| `DISPUTED` | `pending_anchor` | a dispute is open |
| `EXPIRED` | `expired` | a deadline passed before the escrow was funded |
| `CANCELLED` | `expired` | the order was cancelled before the escrow was funded |

### Withdrawal — where it differs

| Order state | SEP-24 status | Why it differs |
|---|---|---|
| `MATCHED` | `pending_user` | the user must sign the funding transaction |
| `AWAITING_ONCHAIN` | `pending_user` | the user's signature is still expected |
| `FUNDED` | `pending_anchor` | the USDC is locked; the provider must now send rupiah |
| `FIAT_PAID` | `pending_user` | the user confirms receipt, or disputes |

Every other withdrawal state follows the deposit table.

**Two things about the amounts, because the table above publishes the statuses they belong to.** On
`refunded`, `amount_out` continues to report what the user would have received and **no `refunds`
object is emitted**, so SEP-24's amount formula does not close for that status. And on a
**withdrawal** the record reports `fee_details.total` as **zero**, because that direction's charge is
carried inside the rate rather than declared as a fee.

**An unmapped order state cannot be served.** The mapping is a total record over the order-state
enum, so a new state is a **compile error**, and a runtime throw guards against a database value
outside the enum. There is no default and nothing is guessed.

---

## 7. The four states SEP-24 cannot express

This is the section this document exists for. Each gap below names whether it is a limit of the
**protocol**, of the **acceptance suite**, or of **this implementation** — because conflating those
three is how specifications become misleading.

**1. Not yet matched — a protocol gap.** `CREATED`, `MATCHED` and `AWAITING_ONCHAIN` all serve
`pending_anchor`. A wallet cannot distinguish *"we are still looking for a provider"* from *"a
provider is committed and the chain is confirming"*. SEP-24 has no status for a matching phase,
because a conventional anchor has none.

**2. Provider failure versus user abandonment — a protocol gap, confined to the pre-escrow window.**
`EXPIRED` and `CANCELLED` both serve `expired`, and both are written **only** from pre-escrow states.
So the two cases that collapse are *the escrow was never funded* and *the order was abandoned* — not,
as one might assume, a provider who failed to pay after funding. That case ends `Refunded` on chain
and serves `refunded`. Worth noting: SEP-24 defines `expired` as funds never received and the
transaction abandoned **by the user**, so serving it for a funding failure is a mild semantic stretch.

**3. A dispute before settlement — an acceptance-suite gap, not a protocol gap.** `DISPUTED` serves
`pending_anchor`, the same status as ordinary processing, so a user in a dispute and a user waiting on
a routine confirmation are told the same thing. **SEP-24 does have the right status**: v3.6.0 added
`on_hold`, for a transaction under additional review. We do not serve it because the
`@stellar/anchor-tests` transaction schema **does not include `on_hold`** in its status enum, so a
more accurate status would fail the acceptance suite deterministically. This anchor pins that decision with a test.

**4. A dispute *after* settlement — partly a protocol gap, and the sharpest of the four.** The escrow
permits a settled trade to be reopened inside its dispute window. When that happens the order leaves
`completed` and serves `pending_anchor`. SEP-24 is not entirely without vocabulary here — `on_hold`
exists, and the `refunds` object can describe money returned after completion — but **there is no
field meaning *this settled, and is now contested***. The practical consequence for a wallet is
concrete: the transaction returns to `pending_anchor` **and loses its `stellar_transaction_id` and
`completed_at`**, both of which are emitted only for `completed` and `refunded`.

**What this implementation does about it, stated as implementation rather than protocol.** SEP-24's
`message` field exists precisely to carry a human explanation alongside a status, and **this anchor
emits it in only four situations** — none of them the four above. Closing that is implementation work,
not a protocol limitation, and naming it here is more useful than claiming the protocol is at fault.
`more_info_url` is served on every transaction and is where the full situation can be described.
`on_change_callback` is defined by SEP-24 for exactly this purpose and is **not implemented**.

**A limit of the acceptance suite worth knowing:** it drives one transaction forward and never
observes a status **regression**, so gap 4 is untested by it in either direction.

---

## 8. What this anchor does not claim

Stated plainly, because a specification that only lists strengths is not one.

- **A SEP-10 challenge is signed and verified but never submitted to the network.** SEP-10 requires
  the challenge to carry an invalid sequence number (0) so that it *cannot* be executed. Its hash
  therefore resolves on no block explorer, and any request for a "SEP-10 transaction hash" rests on a
  misunderstanding of the protocol.
- **The escrow has no concept of identity.** It knows addresses, amounts and deadlines. Every identity
  rule lives in the coordinator; the contract will settle a trade between two addresses it knows
  nothing about.
- **Collateral coverage is enforced by the coordinator, not by the contract.** `create_trade` never
  consults the staking contract. The rule that a provider's committed exposure must not exceed its
  stake is applied at matching time, off chain. What the chain enforces is the consequence: a slash
  fails if the stake is not there.
- **Identity is bound to a verified person, not to a Stellar address**, and one verification
  authorises the accounts this anchor currently accepts for that person. Two carve-outs: an erasure
  request removes non-refused verifications but a **refused** one is redacted and retained, and
  continues to refuse resubmission; and while SEP-12 records are keyed by the memo-inclusive customer
  reference, the **person who is authorised to trade** is resolved with the memo stripped — so a
  custodial wallet's per-user memos collapse to one authorising identity. That is a deliberate
  deviation from SEP-12's shared-account model and is stated here rather than discovered.
- **Two fees exist, not one.** Every release splits out a **platform fee** and a **liquidity-provider
  fee**, paid to two separate addresses fixed when the trade was created. On the deployed
  configuration the platform fee is **30 basis points** and the provider fee is **120** — the larger of
  the two goes to the provider, not to the operator. Both are capped at 500 basis points by the
  contract. **Fees are taken only on release**: a refunded trade returns the full amount and is
  fee-free. The platform address is a fee destination, not a settlement reserve, and it holds no user
  funds; the contract refuses to change it after construction.
- **Recourse is bounded in time and in count**, per §4. After those bounds a settled trade is final on
  chain regardless of the merits.

---

## 9. Reference

| | |
|---|---|
| SEP-1 | `https://lolipay.app/.well-known/stellar.toml` |
| SEP-10 | `WEB_AUTH_ENDPOINT` in the TOML |
| SEP-12 | `KYC_SERVER` in the TOML |
| SEP-24 | `TRANSFER_SERVER_SEP0024` in the TOML |
| Status mapping | `services/coordinator/src/sep24/sep24-status.ts` |
| Transaction serialisation | `services/coordinator/src/sep24/sep24-transaction.ts` |
| Escrow contract | `contracts/escrow/src/lib.rs` |
| Staking contract | `contracts/staking/src/lib.rs` |

Network: Stellar **testnet**. Asset: USDC (test issuance), `is_asset_anchored=false`. The test asset
is not redeemable and is not backed by anything.
