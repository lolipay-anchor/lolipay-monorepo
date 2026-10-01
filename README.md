# lolipay anchor

A non-custodial IDR ⇄ USDC on/off-ramp on Stellar, settled peer-to-peer.

lolipay never holds user funds and never holds a user's signing key. Every trade
is escrowed by a Soroban smart contract, and the rupiah leg is settled directly
between the user and a staked liquidity provider over local rails — bank
transfer, QRIS, or e-wallet.

## Why this exists

A conventional Stellar anchor is an operator that holds fiat reserves and is
trusted with them. Users have to trust it with their money, and the anchor
carries the custody and treasury burden that comes with that.

lolipay presents the same interface with a different engine underneath. There is
no company treasury. Liquidity comes from a network of providers who stake USDC
on-chain, and after a trade has settled the staking contract can take up to the
trade's value from that collateral — all of it, including stake already
unbonding, if the trade was worth as much — when a dispute raised within the
settlement's window ends in a verdict that the settlement was wrong and the
provider was the one left holding the money. Settlement is per-trade escrow, not
a pooled float.

The result is an anchor whose design can be audited rather than trusted; on this
testnet deployment the operator's own host must still be trusted, as
[SECURITY.md](SECURITY.md) states first.

## What it does

Two ramps, both directions of the same escrow:

**Deposit** — the user pays rupiah to a matched provider. The provider's USDC is
already locked in escrow. The payment is marked on chain — by the user's own
wallet in lolipay's app, or by the anchor's attestor key acting on the provider's
wallet-signed receipt, which works on any deposit and is how it happens in the
SEP-24 flow — and the provider's confirmation of receipt releases the USDC to the
user. The contract is what enforces that the confirming signature is the
provider's.

**Withdrawal** — the user locks USDC in escrow. The provider sends rupiah to the
user's bank or e-wallet, uploads proof, and the user's confirmation releases the
USDC to the provider.

Either party can raise a dispute once a trade is awaiting confirmation, and for a
bounded window after it settles. Before settlement, a dispute freezes the escrow
and a resolver chooses release or refund — never a destination; if the resolver
stays silent past its deadline, the administrator may resolve under the same
restriction. After settlement nothing moves: the verdict leaves the payout where
it landed. It establishes liability — which a later claim on the provider's
collateral needs — only when its outcome contradicts the settlement.

## Verifying this anchor yourself

Everything in this section checks the **live testnet deployment**. You do not
need a copy of this repository, an account, a wallet, a key, or a configuration
file. The two commands below need nothing but Node installed; the rest are links
you can open in a browser.

Each result below carries the date it was produced by running the command
immediately above it.

### 1. The conformance suite — SEP-1 and SEP-10

`@stellar/anchor-tests` is the Stellar Development Foundation's own acceptance
suite for anchors. It is not our test suite. It fetches lolipay's public files,
calls lolipay's public endpoints, and prints one line per check.

```bash
npx -y @stellar/anchor-tests@0.6.22 --home-domain lolipay.app --seps 1 10
```

Running it writes to the live anchor: every SEP-10 run consumes challenge
nonces, and each throwaway keypair the suite signs in with also creates an empty
person record and a wallet-link record, which nothing prunes today.

On 2026-09-10 it printed:

```
Tests:       21 passed, 21 total
Time:        54.009s
```

Twenty-one is **5 of 5 SEP-1 checks** and **16 of 16 SEP-10 checks** — nothing
failed, nothing was skipped. A second run ten minutes later printed the same 21
of 21. Those are the suite's own denominators in version 0.6.22: five SEP-1
assertions and sixteen SEP-10 assertions. As *Status* below says, that count does
not show where a refusal puts its details.

**If your run reports failures in the group called *Account Signer Support*, and
each failure's message is about friendbot — it ends "when trying to fund a
testnet account using friendbot", or reads "A 200 Success code is expected for
friendbot requests" — please run the command again.** Those checks first create
brand-new throwaway accounts on the Stellar test network using Stellar's public
faucet, friendbot, and those two messages mean the faucet did not fund the
account. lolipay is not involved in that step. A connection failure that names a
lolipay address instead is lolipay's, and it is a real failure.

### 2. A live SEP-10 login challenge

SEP-10 is how a Stellar wallet proves which account it controls, without ever
sending a password or a key. Ask lolipay for a challenge:

```bash
curl -s "https://api.lolipay.app/auth?account=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
```

On 2026-09-10 it answered HTTP 200 with the following, and on 2026-09-30 it
answered HTTP 200 again:

```
{"transaction":"AAAAAgAAAABl8yYj428/GaR/3DCxXtv/psWL82DEyN/LTophNtXSJgAAAMgAAAAAAAAAAAAAAAEAAAAAaqKiIwAAAABqoqWnAAAAAAAAAAIAAAABAAAAAEI+fQXy7K+/7BkrIVo/G+lq7bjY5wJUq+NBPgIH3layAAAACgAAABBsb2xpcGF5LmFwcCBhdXRoAAAAAQAAAEBySldJaTByaDZvektSdzU0dzJMc0ZOTHZ5S3FCYWJVY1E2RTdEK0tGQ2pRQkpkclFHSHFLUXlPbmt5NEZmVm1z…","network_passphrase":"Test SDF Network ; September 2015"}
```

**Your blob will not match this one, and that is correct.** Every challenge
carries a fresh random nonce and a fresh expiry, so each request returns
different text. Roughly the first eighty characters — which encode the anchor's
own account, the fee, and the sequence number 0 explained below — come back
identical on every call; everything after that changes each time. The response
above is shown shortened.

That blob is a Stellar transaction lolipay built and signed. A wallet decodes it,
confirms it was signed by the `SIGNING_KEY` lolipay publishes (see below), signs
it as well, and posts it back to the same address to receive a session token.
Asking for a challenge writes nothing on the anchor's side, so this check is safe
to repeat.

**There is no on-chain transaction for a SEP-10 exchange, and there cannot be one
— not for lolipay and not for any other anchor.**

SEP-10 requires the challenge to be built with **sequence number 0**. A Stellar
transaction with sequence number 0 can never be accepted by the network, so it
never reaches a ledger, and no block explorer can resolve its hash — the hash
exists, since it is what the wallet signs and the anchor verifies, but it names
nothing on chain. That is the whole point: it is what stops a login challenge
from doubling as a payment somebody tricked you into signing. Decoding the
response above gives `sequence = 0`, and the specification
requires exactly that — see
[SEP-0010, Stellar Web Authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md).

So where an on-chain hash would normally be the evidence, the evidence for SEP-10
is the sixteen conformance checks in step 1 — including the four under *Account
Signer Support*, which build multi-signature accounts and confirm lolipay weighs
signatures against the account's medium threshold rather than just accepting any
one of them — with the one limit *Status* states.

### 3. What the anchor publishes about itself

Open [`https://lolipay.app/.well-known/stellar.toml`](https://lolipay.app/.well-known/stellar.toml)
in a browser. This is the file every Stellar wallet reads first. It returned
HTTP 200 on 2026-09-30 with:

| Field | Value |
|---|---|
| `WEB_AUTH_ENDPOINT` | `https://api.lolipay.app/auth` |
| `SIGNING_KEY` | `GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C` |
| `KYC_SERVER` | `https://api.lolipay.app` |
| `TRANSFER_SERVER_SEP0024` | `https://api.lolipay.app/sep24` |
| currency | USDC, issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| `status` | `test` |

`status="test"` is not a placeholder. It is the honest declaration that this is
the Stellar test network: the USDC here is a test issuance, it is not redeemable,
and it is not backed by anything.

[`https://api.lolipay.app/sep24/info`](https://api.lolipay.app/sep24/info) is the
companion file for the ramps, and lists what each direction currently accepts.
On 2026-09-30 it advertised deposit and withdrawal of USDC, both enabled, 5 to
1000 per transaction, with a deposit `fee_percent` of 1.5 — which is the
on-chain 0.30% platform fee plus the deployed 1.20% provider fee, both of which
appear as separate transfers in each `confirm_and_release` linked below.

### 4. The contracts, and an early rehearsal on chain

Both contracts are public and can be inspected by anyone. These ids were read
from the running production deployment on 2026-09-30, and the running service's
configuration was checked to equal them the same day:

| | |
|---|---|
| escrow | [`CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z`](https://stellar.expert/explorer/testnet/contract/CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z) |
| staking | [`CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2`](https://stellar.expert/explorer/testnet/contract/CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2) |

A trade that settled through the escrow contract above on **2026-09-07**:

[`21129990a9032a5fca2c690193796adf9926a0ca5c910db41b525b634e663837`](https://stellar.expert/explorer/testnet/tx/21129990a9032a5fca2c690193796adf9926a0ca5c910db41b525b634e663837)

It is a single `invoke_host_function` operation calling `confirm_and_release` on
`CDKJ5OX2…`, and the network recorded it as successful.

**What this transaction is, stated plainly:** an earlier rehearsal by lolipay's
own test driver. The deposit that did run end-to-end from an external wallet
client is the next section.

Every hash and contract id on this page is on the Stellar **test** network, which
is wiped periodically. The next reset Stellar has scheduled is **16 December
2026** ([their own notice](https://developers.stellar.org/docs/networks)), and
these links will stop resolving then. That is a property of the test network, not
of lolipay.

## What has actually run on this deployment

This section is the evidence: real transactions on the public test network, one
chain of contract calls per flow, each with the date it happened. Every hash is
a link to the block explorer — or, for the one the explorer had not indexed on
2026-10-01, to Horizon — and can be re-read with the Horizon command under it.
Nothing here is a count of users or a rate of anything — on a test network
every number is the team exercising the system, and none of it is customers.

### A deposit from an external wallet client, settled on chain

On **2026-09-30**, a SEP-24 deposit opened from the Stellar Demo Wallet settled
through the escrow contract. No administrator step was involved: the attestor key
signed automatically when the provider's wallet-signed receipt arrived, and the
administrator's manual attestation route was not used — the coordinator's record
shows this; the chain cannot distinguish the two routes, because both sign with
the one attestor key. The release followed. Horizon's
balance changes on the final transaction show **10.8436159 test-USDC leaving the
escrow contract for the depositor's own account** — the anchor never held it.

The three contract calls, in ledger order, all carrying trade id
`f46566a047c853660c0a849e723142b255f75ad3aeeb545c7a5203e585b30159`:

- `create_trade` — signed by the provider, locking 11.0087470 test-USDC in escrow —
  [`67beb15742dc5e9d611163683f0ef76ff3efcec8fe52a336f564b78bf630c4e9`](https://stellar.expert/explorer/testnet/tx/67beb15742dc5e9d611163683f0ef76ff3efcec8fe52a336f564b78bf630c4e9)
  — 2026-09-30 15:47:22 UTC, ledger 4951931
- `mark_fiat_paid` — signed by the fiat-attestor key the service holds, on the
  provider's wallet-signed receipt (see *The non-custodial boundary*); it moves
  no USDC —
  [`c8fe318837ae57cd0aad5599dced14dd0bd2dccdeda3aa3d7ea875ea1602d728`](https://stellar.expert/explorer/testnet/tx/c8fe318837ae57cd0aad5599dced14dd0bd2dccdeda3aa3d7ea875ea1602d728)
  — 15:49:12 UTC, ledger 4951953
- `confirm_and_release` — signed by the provider; 0.0330262 to the platform fee
  wallet, 0.1321049 to the provider, and 10.8436159 test-USDC to the depositor's
  account —
  [`3c7deab2c2bf48aa495c0d816bcfbbb757c23fb98dbbc744b80d63c74c7d09ca`](https://stellar.expert/explorer/testnet/tx/3c7deab2c2bf48aa495c0d816bcfbbb757c23fb98dbbc744b80d63c74c7d09ca)
  — 15:49:22 UTC, ledger 4951955

```bash
curl -s https://horizon-testnet.stellar.org/transactions/3c7deab2c2bf48aa495c0d816bcfbbb757c23fb98dbbc744b80d63c74c7d09ca | grep -oE '"successful": ?[a-z]+'
```

With the Stellar CLI you can read the trade's on-chain record directly — its
status, amounts, fee rates and deadlines — without a key of your own:

```bash
stellar contract invoke --id CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z --network testnet --source-account GBS7GJRD4NXT6GNEP7ODBMK63P72NRML6NQMJSG7ZNHIUYJW2XJCM64C --send=no -- get_trade --trade_id f46566a047c853660c0a849e723142b255f75ad3aeeb545c7a5203e585b30159
```

**What this deposit is, and is not.** It was made through the Stellar Demo
Wallet by lolipay's founder, from a key the service does not hold; the provider
side was the founder's own provider wallet. No administrator step was involved:
the attestor key signed automatically when the provider's wallet-signed receipt
arrived, and the administrator's manual attestation route was not used — the
coordinator's record shows this; the chain cannot distinguish the two routes,
because both sign with the one attestor key. The release followed. It was made
on the test network, with a test asset, by a person whose identity check was a
vendor-sandbox decision (see *The identity gate* below).

**What the settlement hash proves.** `3c7deab2…` proves the network executed
`confirm_and_release` on the escrow contract with the signatures the contract
requires, and that 10.8436159 test-USDC left the contract for the depositor's
account, with the 1.20% provider fee and the 0.30% platform fee visible in the
same operation. It does not prove that rupiah moved — the fiat leg is off-chain
and is only attested — and it does not prove who the people were.

**The attestor in this chain.** `mark_fiat_paid` was signed by the fiat-attestor
key the service holds, acting on the provider's wallet-signed receipt. It moves
the trade out of the refundable state and nothing else; it cannot release or
redirect funds. Without this sentence three hashes read as if the parties signed
all of it, and they did not.

### The other flows, one chain each

**A withdrawal through the SEP-24 door — a rehearsal by lolipay's own keys,
2026-09-09.** The withdrawing account and the provider were both identities in
lolipay's own keystore. It is linked because it is the complete shape of the
withdrawal on chain: the withdrawing user funds the escrow, the provider marks the
rupiah as sent, the user's confirmation releases.

- `create_trade` — signed by the withdrawing user, locking 8.6869420 test-USDC —
  [`a33e74436bc305f13b24a4d1f063425bd3b7063f7ce96aece4826a04c5893c66`](https://stellar.expert/explorer/testnet/tx/a33e74436bc305f13b24a4d1f063425bd3b7063f7ce96aece4826a04c5893c66)
  — 2026-09-09 07:00:57 UTC, ledger 4582734
- `mark_fiat_paid` — signed by the provider, the party who paid the rupiah —
  [`634612e4d157c099df38799c835fc97a4fcd6b11ada7c92c2864048023e44937`](https://stellar.expert/explorer/testnet/tx/634612e4d157c099df38799c835fc97a4fcd6b11ada7c92c2864048023e44937)
  — 07:01:12 UTC, ledger 4582737
- `confirm_and_release` — signed by the withdrawing user; 0.0260608 and
  0.1042433 in fees, 8.5566379 test-USDC to the provider —
  [`43fe0e5cff3e20c2c1328b23e18e53e4140aff22e8094af7c022c2e02087f856`](https://stellar.expert/explorer/testnet/tx/43fe0e5cff3e20c2c1328b23e18e53e4140aff22e8094af7c022c2e02087f856)
  — 07:01:42 UTC, ledger 4582743

Withdrawal is advertised in `/sep24/info` and the door is open, but it is not
the standard SEP-24 withdrawal mechanism: there is no anchor account to pay
(`withdraw_anchor_account` is served as null), because the user signs
`create_trade` into the escrow from the interactive page, which needs the
Freighter browser extension on that page: the page speaks Freighter's message
protocol and no other. Every SEP-24 withdrawal that has completed so far was
signed on the user's side by lolipay's own account, as above. Withdrawal from external
wallet clients is outside the current scope; withdrawal through lolipay's own
application has settled trades on the same contract, and they are not linked
here because the accounts on them are not lolipay's.

**An automatic refund, 2026-09-28.** A SEP-24 deposit was funded by the provider
and no rupiah was ever marked as sent. The escrow's `refund` is permissionless
once the confirm deadline passes; the coordinator's refund fee-payer called it 12
seconds after the deadline, and the escrowed amount went back to the address that
funded it. Both parties were identities in lolipay's own keystore.

- `create_trade` — signed by the provider, locking 10.9593525 test-USDC —
  [`0582a7a0ad6073350c93d12eb0f99f743cdf2895034685fe8347a5098b62bc2f`](https://stellar.expert/explorer/testnet/tx/0582a7a0ad6073350c93d12eb0f99f743cdf2895034685fe8347a5098b62bc2f)
  — 2026-09-28 12:59:27 UTC, ledger 4915356; the trade's confirm deadline was
  13:59:20 UTC
- `refund` — submitted by the refund fee-payer; 10.9593525 test-USDC back to the
  provider, no fee taken —
  [`e7168047f3fcac2b855ec3a52b89231960044f7ec5101e4c51ba65e879d4155b`](https://stellar.expert/explorer/testnet/tx/e7168047f3fcac2b855ec3a52b89231960044f7ec5101e4c51ba65e879d4155b)
  — 13:59:32 UTC, ledger 4916077

**A dispute and its resolution — exercised once, by the operator, 2026-09-01.**
The dispute path exists on chain and has been run once, on a one-USDC trade that
lolipay opened against the live contract outside the production coordinator, with
both parties identities in lolipay's own keystore. The resolver raised the dispute
and resolved it as a release.

- `raise_dispute` — signed by the resolver —
  [`a7d4bdd55afe4133f95ebdb3d99d796172c3f0aa2d62842d12925ee008cd6998`](https://stellar.expert/explorer/testnet/tx/a7d4bdd55afe4133f95ebdb3d99d796172c3f0aa2d62842d12925ee008cd6998)
  — 2026-09-01 19:46:07 UTC, ledger 4453676
- `resolve` (release) — signed by the resolver; 0.0030000 in fee, 0.9970000
  test-USDC to the recipient —
  [`bb00d9a10af2c393395444e7311019c810f9ebbc57944b93186d088a26976edc`](https://stellar.expert/explorer/testnet/tx/bb00d9a10af2c393395444e7311019c810f9ebbc57944b93186d088a26976edc)
  — 19:46:17 UTC, ledger 4453678

No trade opened by a customer has ever been disputed. On 2026-09-30 no order in
the production database carried a dispute, a resolution, or an on-chain disputer
— the operator's query, shown so the figure has a command beside it:

```sql
SELECT count(*) FILTER (WHERE "disputeAt" IS NOT NULL OR resolution IS NOT NULL OR "onChainDisputedBy" IS NOT NULL), count(*) FROM "Order";
```

**Provider collateral — the staking contract, every call it has ever received.**
Two providers have staked. The second one has also requested, waited out the
five-day cooldown, and claimed an unstake, which is the whole exit path:

- `stake` 100 — provider 1 —
  [`c1d9662c448699f092bda6c66846b879b74b584e81b8530f70c6dedc6c88c994`](https://stellar.expert/explorer/testnet/tx/c1d9662c448699f092bda6c66846b879b74b584e81b8530f70c6dedc6c88c994)
  — 2026-08-26 15:57:43 UTC
- `stake` 100 — provider 2 —
  [`5b86cdce021a810052eee8999ff278bd4b4081e54f330bd4ce413f6f254c4f16`](https://stellar.expert/explorer/testnet/tx/5b86cdce021a810052eee8999ff278bd4b4081e54f330bd4ce413f6f254c4f16)
  — 2026-09-10 07:42:42 UTC
- `request_unstake` — provider 2 —
  [`c631718c1c8ce3f52cb6cfadcf8aa21d3612e60287ba0339c322ebcca91c8f67`](https://stellar.expert/explorer/testnet/tx/c631718c1c8ce3f52cb6cfadcf8aa21d3612e60287ba0339c322ebcca91c8f67)
  — 2026-09-20 08:32:47 UTC
- `stake` 10 and `stake` 100 — provider 2 —
  [`0b39b443cb0d98f503d48ac71459d925b1814498d5e24f3f8011930f0ee03388`](https://stellar.expert/explorer/testnet/tx/0b39b443cb0d98f503d48ac71459d925b1814498d5e24f3f8011930f0ee03388)
  and
  [`a4d2ae324bda6b67aaabeacfa32898cfa656aa8c47a683c41695decf86b87d03`](https://stellar.expert/explorer/testnet/tx/a4d2ae324bda6b67aaabeacfa32898cfa656aa8c47a683c41695decf86b87d03)
  — 2026-09-20 08:33:22 and 08:43:57 UTC
- `claim_unstake` 10 — provider 2, ten days after the request —
  [`2a6a2ce2470f714c5f38a7a7033facd71ddd3ae4485112930aa87f4ffb46f6fb`](https://horizon-testnet.stellar.org/transactions/2a6a2ce2470f714c5f38a7a7033facd71ddd3ae4485112930aa87f4ffb46f6fb)
  — 2026-09-30 17:56:07 UTC

100 + 100 + 10 + 100 − 10 = 300, and 300.0000000 test-USDC is what the staking
contract held on 2026-09-30, read from the asset's own contract. No slash has
ever run; the limit on slashing is stated under *Status* below.

### The identity gate

lolipay's coordinator opens no deposit order for an account whose identity row is
not both accepted and screened. That rule lives in the coordinator, not on chain:
the escrow knows addresses and amounts and has no allowlist. The same rule gates
the SEP-24 interactive flow in both directions and lolipay's own app, and it is
pinned by a test that turns the rule off and watches an accepted-but-unscreened
identity get through.

Against the SDF conformance suite, SEP-12 passed **14 of 14 checks on 2026-09-10
03:59 UTC**, run against the deployed anchor — the suite's ten SEP-12 checks and
the four SEP-1 and SEP-10 checks they depend on; as *Status* below says, that
count does not show where a refusal puts its details. That suite is not listed as a
command above because it opens real verification sessions with the outside
provider.

**Two surfaces, not one.** The five identity fields (first name, last name,
email address, document type, document country) are collected on a page
lolipay's coordinator renders inside the wallet's popup; the document and face
capture happen on the verification provider's own hosted page, to which that
popup hands the person; the decision comes back to lolipay by webhook.

**What is stored, and what is not.** From the identity check, lolipay stores the
decision, the verification provider's session identifier for it, the wallet
account it belongs to, and an email if one was given — not the name, the
document or the face; the provider keeps them, and lolipay's provider API key can
retrieve the session's record from the provider by that identifier. The
provider's full webhook payload crosses the wire and
is discarded after the decision is read from it. **That is the identity check
only.** lolipay also stores what people type or upload, including: the bank or
e-wallet account a payout goes to, where the app's own example asks for the
account holder's name; a provider's payment details, contact details and proof
of liquidity; and the transfer proofs and dispute evidence people upload, as
images or PDFs.

**What "screened" means here.** The provider's sanctions and watchlist check ran
at verification time and returned nothing; an accepted identity without that
check opens no deposit. It is a one-time check at verification, and this
deployment records and acts on no re-screening after approval: provider
deliveries about a user rather than a session are acknowledged and discarded.

**No live identity screening has ever been recorded here.** The verification
provider's application this deployment is bound to runs in sandbox mode, so no
real document, face or name has ever been checked here. The service says so at
boot — `identity verification runs through the provider, environment sandbox` —
and the database agrees: on 2026-09-30 19:41 UTC, **0** verification rows
carried a live environment and **136** carried the sandbox one. The command,
which the operator ran against the production database and which counts rows,
not people (one person can be many sessions) — shown so the figure has a command
beside it, not because a reader can run it:

```sql
SELECT count(*) FILTER (WHERE environment = 'live'), count(*) FILTER (WHERE environment = 'sandbox') FROM "KycVerification";
```

Screening real identities needs a live application with the provider. A recorded
verification session, redacted of personal data, has **not yet
been recorded**.

This page reports what the code enforces and what the SDF conformance suite
measured on the dates given. It does not claim that lolipay satisfies any KYC or
AML regulation, or holds any licence.

### How this maps to the funded scope

| Deliverable | Present today | Partial or bounded | Not yet |
|---|---|---|---|
| D1 — SEP-1 and SEP-10 | live `stellar.toml`; 21 of 21 on 2026-09-10; the challenge in step 2 | the count does not show where a refusal puts its details (see *Status*) | an on-chain SEP-10 transaction is impossible by protocol design (sequence 0), explained in step 2 |
| D2 — SEP-12 and the identity gate | 14 of 14 on 2026-09-10 (ten SEP-12 checks, four SEP-1 and SEP-10); the gate and its test | every screening is a vendor-sandbox decision; the count does not show where a refusal puts its details (see *Status*) | a recorded verification session, redacted of personal data |
| D3 — SEP-24 deposit | the 2026-09-30 chain above, from the Stellar Demo Wallet | operated by lolipay's founder on both sides; testnet; sandbox identity | a screen recording of that deposit — **not yet recorded** |
| D4 — status mapping | [ANCHOR-STATUS-MAPPING.md](ANCHOR-STATUS-MAPPING.md) in this public repository | — | — |

## Status

Testnet. The escrow, staking, matching, dispute and settlement paths are built
and covered by the suites below. Each anchor protocol, with the date its figure
was measured:

**SEP-1 — live.** The `stellar.toml` above is served and passed 5 of 5 SEP-1
checks (2026-09-10); its values were re-read unchanged on 2026-09-30.

**SEP-10 — live.** 16 of 16 checks (2026-09-10), including multi-signature
accounts and medium-threshold signature weighting. As explained above, a SEP-10
exchange puts no transaction on chain by design, so the sixteen checks are the
evidence. That count does not show that a refusal carries its details under
`error`, the key SEP-10 uses for them: the suite reads a refusal's body on two
malformed challenge requests and checks only that `error` is a non-empty string,
which `"Bad Request"` satisfies. On 2026-10-01 `GET /auth` without an account
answered
`{"message":["account must be shorter than or equal to 80 characters","account must be a Stellar address","account must be a string"],"error":"Bad Request","statusCode":400}`.
On 2026-09-30 a fresh challenge was decoded offline and verified
against the published `SIGNING_KEY`, with sequence number 0 and both domains.

**SEP-12 — live.** 14 of 14 checks (2026-09-10 03:59 UTC): the suite's ten SEP-12
checks and the four SEP-1 and SEP-10 checks they depend on. That count does not
show that a refusal carries its details under `error`, the key SEP-12 uses for
them: no SEP-12 check in the suite reads a refusal's body, and on 2026-10-01
`GET /customer` without a token answered `{"message":"Unauthorized","statusCode":401}`.
No live identity
screening has ever been recorded here: the provider application this deployment
is bound to is a sandbox, as measured under *The identity gate* above.

**SEP-24 — live for deposit, on testnet.** The last logged run of the SDF suite
against production, on **2026-09-04 20:12 UTC** with both directions enabled,
printed `42 passed, 1 skipped, 43 total`. That count does not show that a refusal
carries its explanation in `error`, as SEP-24 describes. The suite reads a
refusal's body only on five invalid deposit and withdrawal requests, and there
checks only that `error` is not empty, which the bare reason phrase
`"Bad Request"` satisfies; it checks a refusal for a missing token by its status
code alone. On 2026-10-01 `GET /sep24/transaction` without a token answered
`{"message":"this endpoint requires a SEP-10 token","error":"Forbidden","statusCode":403}`.
Nor does it show that a deposit or withdrawal refused for a missing token answers
`{"type":"authentication_required"}`, as SEP-24 specifies; on 2026-10-01 this
anchor answered that request with the same generic body.
An earlier edition of this page gave a
later per-direction figure for which no run log exists; it is withdrawn. The
suite checks the transactions named in its configuration against the statuses it
expects, and the pending deposit it names has since been refunded, so a re-run
needs a newly configured pending deposit before the check that reads it means
anything. A deposit from an external wallet client has settled, as shown above;
the screen recording of it has not yet been recorded.

**Withdrawal** is advertised in `/sep24/info` and live through lolipay's own
application, with the limits stated under *The other flows* above. Making that
direction work from external wallet clients is not part of the current scope.

The SEP-12 and SEP-24 suites are not listed as commands to run above, because
they need anchor-side configuration and write to the anchor they are pointed at:
the SEP-12 run opens verification sessions with the outside provider, and the
SEP-24 run creates transaction records. The figures above are the measured
results, dated.

**One limit is named here rather than left to be discovered.** The staking
contract implements slashing and its tests cover it; the coordinator builds the
transaction — `GET /orders/:id/tx/slash` and `GET /orders/:id/slash-state`, both
restricted to an administrator — and the admin console offers it on the
settlements where a provider can be the culprit. Before building, the coordinator
refuses unless the signing wallet is the address the contract itself names as
resolver or administrator. On the current testnet deployment those two addresses
are command-line keystore identities on the coordinator's host rather than browser
wallets, so a slash today is signed from that keystore — the same keystore that
holds the fiat attestor, which is the limitation listed under *One keystore holds
every operator role today* in [SECURITY.md](SECURITY.md). It can only be done
*after* a dispute has been resolved, never before: the staking contract refuses a
slash until a verdict has established liability, and refuses one entirely on a
dispute raised before settlement, because while the money is still in escrow,
releasing or refunding it is the remedy.

## Architecture

```
contracts/escrow      Soroban escrow — holds USDC per trade, enforces the state
                      machine, distributes fees, handles disputes and refunds
contracts/staking     provider collateral, unbonding, and slash bound to a
                      disputed escrow trade

services/coordinator  NestJS. Matches orders, prices quotes, indexes on-chain
                      events, serves the API and the SEP endpoints. Builds
                      unsigned transactions and never signs a user's.

frontend/apps/web     the user app — connect a wallet, buy, sell, dispute
frontend/apps/lp      the provider console — stake, availability, assignments
frontend/apps/admin   operator console — config, orders, dispute resolution
frontend/apps/landing the public site, which also renders stellar.toml and the
                      /anchor page for wallet developers

frontend/packages     shared API client, wallet adapter, UI, config
```

[ANCHOR-STATUS-MAPPING.md](ANCHOR-STATUS-MAPPING.md) is the specification for how
this peer-to-peer engine is presented through SEP-24 — including the states the
protocol has no words for, and what the operator's keys can and cannot reach.

The SEP implementations live in
[`services/coordinator/src/sep10/`](services/coordinator/src/sep10/),
[`services/coordinator/src/sep24/`](services/coordinator/src/sep24/),
[`services/coordinator/src/kyc/`](services/coordinator/src/kyc/) and
[`services/coordinator/src/anchor/`](services/coordinator/src/anchor/).

### The non-custodial boundary

The coordinator builds and simulates Soroban transactions, then returns them
**unsigned**. Whichever party the contract's `require_auth` names is the party
that signs, in their own wallet. In the SEP-24 interactive flow the signed
transaction goes from the browser straight to the Soroban RPC endpoint; it never
passes through the coordinator.

The coordinator service holds three Stellar keys of its own, and each one is
narrowly bounded — the first by what the function it calls is able to do at all,
the second by the contract that names it, the third by the protocol itself.

The first pays transaction fees for the **auto-refund** cron. The escrow's
`refund` is permissionless on-chain and can only return the USDC to the account
that funded that escrow — the liquidity provider on a deposit, the user on a
withdrawal — so that key cannot redirect, release, resolve, or dispute anything.

The second is the **fiat attestor**. On a deposit the user pays rupiah through a
hosted flow. They authenticated over SEP-10, so they do hold a Stellar key — what
they lack is a channel to sign with it mid-flow. SEP-24's interactive webview
talks back to the wallet through exactly two channels: a `callback` fired once
when the flow completes, and an `on_change_callback` fired when the status
changes. Both carry a JSON message, neither carries an XDR, SEP-24 defines no way
for the wallet to sign a transaction mid-flow — and this anchor implements neither
channel, so a
wallet polls the transaction endpoint, as
[ANCHOR-STATUS-MAPPING.md](ANCHOR-STATUS-MAPPING.md) records. So something else
has to mark on chain that the deposit was paid. That is what this key is for, and
it is the only thing it does alone. It does not observe any bank: it acts on the
provider's wallet-signed receipt of the rupiah, submitted through
`POST /orders/:id/confirm-receipt`, or on an administrator's attestation through
`POST /admin/orders/:id/attest`. The depositor's own "I have paid" in the popup
touches no key and nothing on chain: it records the claim, notifies the provider
to check their account, and changes the SEP-24 status served for that
transaction from `pending_user_transfer_start` to `pending_anchor`, with a
`message` saying so.
The contract accepts the attestor only for a deposit, only while that trade is
still funded, only inside the trade's deadline, and only if it is the exact
attestor address the contract itself was configured with. It is also a required
second signature when a resolver settles a dispute raised while a trade is still
funded. It cannot release funds by itself, cannot choose a destination, and
cannot resolve a dispute. The contract additionally refuses to let the attestor,
the resolver and the administrator be the same address, or to let any of them be
a party to a trade.

What it **can** do belongs beside those refusals, because a list of prohibitions
with no permissions in it reads as concealment. Marking fiat paid moves a trade out
of the funded state, and the escrow's permissionless refund only applies to a
funded trade. A false attestation therefore takes a deposit off the automatic
refund path and makes recovery depend on a dispute and a resolver. That is a
liveness cost, not a custody one — the key still cannot take the money or send it
anywhere.

The third signs the **SEP-10 login challenges** from step 2, and nothing else. It
is the least powerful of the three by a wide margin: every challenge it signs is
built with sequence number 0, so nothing it signs on that path can ever be
accepted by the network. No contract names it. Its account does exist on the test
network and holds test XLM, which this key controls; the service uses the key for
nothing but login challenges. Its public half is the `SIGNING_KEY` published in
`stellar.toml`, which is how a wallet checks that a challenge really came from
lolipay. It is held in the service's environment — on the host, the coordinator's
environment file — and is not one of the host keystore's identities.

None of the three can release escrowed funds, choose a destination, or resolve a
dispute on its own.

The resolver and administrator addresses the escrow names are **not** held by the
service: the coordinator can only build the transactions they would sign, never
sign them. They are operator keys, held by a person — and on the current testnet
deployment they live in a command-line keystore on the same host that runs the
coordinator, beside the fiat attestor and the refund fee-payer, which are each
present both in that keystore and in the service's environment. One keystore
therefore holds every privileged role at once, which is a stronger statement than
"three separate addresses" and is the first entry under *Known limitations* in
[SECURITY.md](SECURITY.md). That is a property of this deployment rather than of
the design.

See [SECURITY.md](SECURITY.md) for the invariants behind this, and for what it
deliberately does not defend against.

## Running it

Requires Node 22, Rust with the `wasm32v1-none` target, Docker, and Postgres.

**Contracts**

```bash
cargo test
cargo build --target wasm32v1-none --release
```

**Coordinator** — the simplest run is everything in containers. It uses the
coordinator's own template, `services/coordinator/.env.example`, not the one at
the repository root; the two declare different sets of names.

```bash
cd services/coordinator
[ -f .env ] || cp .env.example .env
```

Fill in `services/coordinator/.env` before starting it: the names
[`services/coordinator/README.md`](services/coordinator/README.md) lists as
refusing to start, and in `DATABASE_URL` the development Postgres password,
`lolipay`, in place of the template's placeholder. Then:

```bash
docker compose up -d
```

That starts Postgres, MinIO and the coordinator itself on `127.0.0.1:3000`; the
container applies the numbered migrations in `prisma/migrations` before it
listens. If the coordinator exited on its first start — its migrations can run
before Postgres accepts connections — run `docker compose up -d` again. That is
the supported local run. Running the service on the host
instead is not something the tracked files set up: the compose file publishes
Postgres to the host but not MinIO, and the object store client is constructed
at boot from six `MINIO_*` names that only the compose files supply, so a
host-side `npm run start:dev` needs a MinIO the host can reach and those six
names exported by hand, the Prisma client generated with `npx prisma generate`
after `npm ci`, and `DATABASE_URL` exported with its host changed from the
compose service name `postgres` to `127.0.0.1` and its password set to
`lolipay`.
[`services/coordinator/README.md`](services/coordinator/README.md) says what they
are.

The schema is applied by the numbered migrations in `prisma/migrations`, so it is
`prisma migrate deploy` and not `prisma db push` — `db push` would bypass the
migration history. [`services/coordinator/README.md`](services/coordinator/README.md)
has the variable list and every route.

**Frontend**

```bash
cd frontend
pnpm install
pnpm dev
```

Three of the four apps carry a tracked `.env.example`; the provider console's is
ignored by that app's own `.gitignore`, so a fresh clone must write it by hand
from the names the app reads. From `frontend/`, in another terminal:

```bash
grep -rhoE 'NEXT_PUBLIC_[A-Z_]+' apps/lp --include='*.ts' --include='*.tsx' | sort -u
```

No example file carries a secret. The coordinator's
template names the public testnet USDC issuer; the fee wallet and the contract
ids are empty: the service refuses to start without the fee wallet, and whatever
reads a contract id fails with `Missing env …` until it is set.

## Tests

Each count below carries the commit and date it was measured at, by running the
command above it. The deployed commit is `495f408`, which adds the 2026-09-30
hotfixes — the SEP-24 status change among them — on top of `da57036` and changes
production code; the counts were not re-measured at it.

```bash
cargo test
```

251 contract tests, no failures — 178 for the escrow contract and 73 for the
staking contract (`da57036`, 2026-09-30).

```bash
cd services/coordinator
npm ci
npx prisma generate
npm test
```

3,473 coordinator unit tests passing, 3 skipped, 3,476 in total, across 199 of
200 suites (`da57036`, 2026-09-30). The one skipped suite is the testnet
integration suite, whose three tests are the three skipped.

```bash
cd frontend && pnpm test -- --force
```

1,044 distinct frontend tests across 102 files (`da57036`, 2026-09-30). The
runner prints **1,166** over 120 file runs, because `apps/web/vitest.config.ts`
also includes `../../packages/*/src/**`, so the shared `@lolipay/ui` (64 tests)
and `@lolipay/api-client` (58) suites execute twice — once inside web's 493 and
once as their own turbo tasks; the `@lolipay/wallet` suite has no task of its own
and runs once, inside web. Both numbers are given so that the figure on this page
matches what the command actually prints. `pnpm test` is `turbo run test` with
caching left on, so a second run can replay a cached result without executing
anything — reproduce the figure above with `--force`, or on a cold cache.

The coordinator's end-to-end tests need Postgres and MinIO. They are a separate
run because they need those services, not because they are optional:

```bash
cd services/coordinator
npm run e2e:up
npm run test:e2e
npm run e2e:down
```

448 end-to-end tests across 39 suites, no failures, measured at `c37dca6` on
2026-09-30 00:30 UTC by the host's nightly run; no end-to-end test file changed
between that commit and `da57036`, and the suite was not re-run for this edit.

`npm run test:all` does the whole sequence and tears down afterwards. Both
services use tmpfs, so every run starts from an empty database.

The testnet integration suite is opt-in behind `RUN_TESTNET_IT` and takes its
contract ids from the environment.

## Security

Non-trivial invariants — the non-custodial boundary, escrow guarantees,
concurrency controls, and the fail-closed rules — are documented in
[SECURITY.md](SECURITY.md), together with what this deployment does not yet
separate. If you believe you have found a vulnerability, report it privately
through GitHub's private vulnerability reporting on this repository — under the
repository's security tab, choose **Report a vulnerability** — rather than
opening a public issue.

## Licence

[Apache-2.0](LICENSE).
