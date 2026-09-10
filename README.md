# lolipay anchor

A non-custodial IDR ⇄ USDC on/off-ramp on Stellar, settled peer-to-peer.

lolipay never holds user funds and never holds a user's signing key. Every trade
is escrowed by a Soroban smart contract, and the rupiah leg is settled directly
between the user and a staked liquidity provider over local rails — bank
transfer, QRIS, or e-wallet.

## Why this exists

A conventional Stellar anchor is a licensed operator holding fiat reserves. Users
have to trust it with their money, and the anchor carries the custody and
treasury burden that comes with that.

lolipay presents the same interface with a different engine underneath. There is
no company treasury. Liquidity comes from a network of providers who stake USDC
on-chain, and the staking contract can take that collateral from a provider who
is party to a genuinely disputed trade. Settlement is per-trade escrow, not a
pooled float.

The result is an anchor that can be audited rather than trusted.

## What it does

Two ramps, both directions of the same escrow:

**Deposit** — the user pays rupiah to a matched provider. The provider's USDC is
already locked in escrow; once the user confirms payment, the contract releases
it to the user.

**Withdrawal** — the user locks USDC in escrow. The provider sends rupiah to the
user's bank or e-wallet, uploads proof, and the user's confirmation releases the
USDC to the provider.

Either party can raise a dispute once a trade is awaiting confirmation, and for a
bounded window after it settles. A dispute freezes the trade and hands it to a
resolver who may choose release or refund — never a destination.

## Verifying this anchor yourself

Everything in this section checks the **live testnet deployment**. You do not
need a copy of this repository, an account, a wallet, a key, or a configuration
file. The two commands below need nothing but Node installed; the rest are links
you can open in a browser.

Every result printed here was produced on **2026-09-10** by running the command
immediately above it.

### 1. The conformance suite — SEP-1 and SEP-10

`@stellar/anchor-tests` is the Stellar Development Foundation's own acceptance
suite for anchors. It is not our test suite. It fetches lolipay's public files,
calls lolipay's public endpoints, and prints one line per check.

```bash
npx -y @stellar/anchor-tests@0.6.22 --home-domain lolipay.app --seps 1 10
```

It printed:

```
Tests:       21 passed, 21 total
Time:        54.009s
```

Twenty-one is **5 of 5 SEP-1 checks** and **16 of 16 SEP-10 checks** — nothing
failed, nothing was skipped. A second run ten minutes later printed the same 21
of 21.

**If your run reports one to three failures in the group called *Account Signer
Support*, and the message mentions `friendbot` or a connection error, please run
the command again.** Those particular checks have to create brand-new throwaway
accounts on the Stellar test network first, and they get them from Stellar's
public faucet, which everybody shares and which is often busy. When that faucet
does not answer in time, the check reports an error. **That is Stellar's faucet
being busy — it is not lolipay answering wrongly, and lolipay is not involved in
that step at all.** A second run normally comes back green.

### 2. A live SEP-10 login challenge

SEP-10 is how a Stellar wallet proves which account it controls, without ever
sending a password or a key. Ask lolipay for a challenge:

```bash
curl -s "https://api.lolipay.app/auth?account=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
```

It answered HTTP 200 with:

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

**There is no transaction hash for a SEP-10 exchange, and there cannot be one —
not for lolipay and not for any other anchor.**

SEP-10 requires the challenge to be built with **sequence number 0**. A Stellar
transaction with sequence number 0 can never be accepted by the network, so it
never reaches the ledger and never gets a hash. That is the whole point: it is
what stops a login challenge from doubling as a payment somebody tricked you into
signing. Decoding the response above gives `sequence = 0`, and the specification
requires exactly that — see
[SEP-0010, Stellar Web Authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md).

So where a hash would normally be the evidence, the evidence for SEP-10 is the
sixteen conformance checks in step 1 — including the four under *Account Signer
Support*, which build multi-signature accounts and confirm lolipay weighs
signatures against the account's medium threshold rather than just accepting any
one of them.

### 3. What the anchor publishes about itself

Open [`https://lolipay.app/.well-known/stellar.toml`](https://lolipay.app/.well-known/stellar.toml)
in a browser. This is the file every Stellar wallet reads first. It returned
HTTP 200 on 2026-09-10 with:

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

### 4. The contracts, and one settled trade on chain

Both contracts are public and can be inspected by anyone. These ids were read
from the running production deployment on 2026-09-10:

| | |
|---|---|
| escrow | [`CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z`](https://stellar.expert/explorer/testnet/contract/CDKJ5OX2WY424DXPMYRGI2TCMTI5LFGLSLHSBKA5AODIGTS4R2TIDK3Z) |
| staking | [`CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2`](https://stellar.expert/explorer/testnet/contract/CAVJAMGCNBJQIDE6U7DHGYIWUREBOYH6PI2GWERLCF2DV6AGRAZOUBG2) |

A trade that settled through the escrow contract above, on **2026-09-07**:

[`21129990a9032a5fca2c690193796adf9926a0ca5c910db41b525b634e663837`](https://stellar.expert/explorer/testnet/tx/21129990a9032a5fca2c690193796adf9926a0ca5c910db41b525b634e663837)

It is a single `invoke_host_function` operation calling `confirm_and_release` on
`CDKJ5OX2…`, and the network recorded it as successful.

**What this transaction is, stated plainly:** a rehearsal driven by lolipay's own
test driver, not by a third-party wallet. A run driven end-to-end from the
Stellar Demo Wallet has not been recorded yet.

Every hash and contract id on this page is on the Stellar **test** network, which
is wiped periodically. The next reset Stellar has scheduled is **16 December
2026** ([their own notice](https://developers.stellar.org/docs/networks)), and
these links will stop resolving then. That is a property of the test network, not
of lolipay.

## Status

Testnet. The escrow, staking, matching, dispute and settlement paths are built
and covered by the suites below. Each anchor protocol, with the date its figure
was measured:

**SEP-1 — live.** The `stellar.toml` above is served and passes 5 of 5 SEP-1
checks (2026-09-10).

**SEP-10 — live.** 16 of 16 checks (2026-09-10), including multi-signature
accounts and medium-threshold signature weighting. As explained above, a SEP-10
exchange produces no transaction hash by design, so the sixteen checks are the
evidence.

**SEP-12 — live.** 14 of 14 checks (measured 2026-09-10 03:59 UTC). Stated
plainly, because it matters more than the number: **every identity screening on
record so far is a decision returned by the verification provider's sandbox. No
real person's identity has been screened yet.** Closing that needs a live
application with the provider, not a change to this code.

**SEP-24 — live for deposit, on testnet.** The deposit section passes 13 of 14
checks (2026-09-10). The one failure is not an anchor response: it is a test
fixture pinned on 2026-09-04 that has since aged out of
`pending_user_transfer_start` into `refunded`, so the check compares against a
state that expired. The demonstration recording of a deposit driven from the
Stellar Demo Wallet has not been captured yet.

**Withdrawal** is live through lolipay's own application and is advertised in
`/sep24/info`. Making that direction work from third-party wallets is not part of
the current scope.

The SEP-12 and SEP-24 suites are not listed as commands to run above, because
unlike SEP-1 and SEP-10 they need anchor-side configuration and open real
verification sessions with an outside provider. The figures above are the
measured results, dated.

**One limit is named here rather than left to be discovered.** The staking
contract implements slashing and its tests cover it; the coordinator builds the
transaction — `GET /orders/:id/tx/slash` and `GET /orders/:id/slash-state`, both
restricted to an administrator — and the admin console offers it on the
settlements where a provider can be the culprit. Before building, the coordinator
refuses unless the signing wallet is the address the contract itself names as
resolver or administrator. On the current testnet deployment those two addresses
are command-line keystore identities on the coordinator's host rather than browser
wallets, so a slash today is signed from that keystore — which is the same
limitation listed under *Operator keys share a host with the service today* in
[SECURITY.md](SECURITY.md). It can only be done *after* a dispute has been
resolved, never before: the staking contract refuses a slash until a verdict
has established liability, and refuses one entirely on a dispute raised before
settlement, because while the money is still in escrow, releasing or refunding it
is the remedy.

## Architecture

```
contracts/escrow      Soroban escrow — holds USDC per trade, enforces the state
                      machine, distributes fees, handles disputes and refunds
contracts/staking     provider collateral, unbonding, and slash bound to a
                      disputed escrow trade

services/coordinator  NestJS. Matches orders, prices quotes, indexes on-chain
                      events, serves the API. Builds unsigned transactions and
                      never signs a user's.

frontend/apps/web     the user app — connect a wallet, buy, sell, dispute
frontend/apps/lp      the provider console — stake, availability, assignments
frontend/apps/admin   operator console — config, orders, dispute resolution
frontend/apps/landing the public site

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
that signs, in their own wallet.

The coordinator service holds three Stellar keys of its own, and each one is
narrowly bounded — the first by what the function it calls is able to do at all,
the second by the contract that names it, the third by the protocol itself.

The first pays transaction fees for the **auto-refund** cron. The escrow's
`refund` is permissionless on-chain and can only return funds to the original
provider, so that key cannot redirect, release, resolve, or dispute anything.

The second is the **fiat attestor**. On a deposit the user pays rupiah through a
hosted flow. They authenticated over SEP-10, so they do hold a Stellar key — what
they lack is a channel to sign with it mid-flow. SEP-24's interactive webview
talks back to the wallet through exactly two channels: a `callback` fired once
when the flow completes, and an `on_change_callback` fired when the status
changes — which the protocol defines and this anchor does not implement, as
[ANCHOR-STATUS-MAPPING.md](ANCHOR-STATUS-MAPPING.md) records. Both carry a JSON
message, neither carries an XDR, and SEP-24 defines no signing mechanism of its
own. So something else has to
record on-chain that the rupiah arrived — that is what this key is for, and it is
the only thing it does alone. The contract accepts it only for a deposit, only
while that trade is still funded, only inside the trade's deadline, and only if it
is the exact attestor address the contract itself was configured with. It is also
a required second signature when a resolver settles a dispute raised while a trade
is still funded. It cannot release funds by itself, cannot choose a destination,
and cannot resolve a dispute. The contract additionally refuses to let the
attestor, the resolver and the administrator be the same address, or to let any of
them be a party to a trade.

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
accepted by the network. It moves nothing and it holds nothing. Its public half is
the `SIGNING_KEY` published in `stellar.toml`, which is how a wallet checks that a
challenge really came from lolipay.

None of the three can release escrowed funds, choose a destination, or resolve a
dispute on its own.

The resolver and administrator addresses the escrow names are **not** held by the
service: the coordinator can only build the transactions they would sign, never
sign them. They are operator keys, held by a person — and on the current testnet
deployment they live in a command-line keystore on the same host that runs the
coordinator, with the fiat attestor and the refund fee-payer each present both in
that keystore and in the service's environment. That is a property of this
deployment rather than of the design, and it is listed under Known limitations
rather than glossed over.

See [SECURITY.md](SECURITY.md) for the invariants behind this, and for what it
deliberately does not defend against.

## Running it

Requires Node 22, Rust with the `wasm32v1-none` target, Docker, and Postgres.

**Contracts**

```bash
cargo test
cargo build --target wasm32v1-none --release
```

**Coordinator** — copy `.env.example` to `.env` and fill in the values first.

```bash
cd services/coordinator
cp .env.example .env
docker compose up -d
npm ci && npx prisma migrate deploy
npm run start:dev
```

The schema is applied by the numbered migrations in `prisma/migrations`, so it is
`prisma migrate deploy` and not `prisma db push` — `db push` would bypass the
migration history.

**Frontend**

```bash
cd frontend
pnpm install
pnpm dev
```

Each app has its own `.env.example`. No example file carries a live value: the
contract ids, the fee wallet, and the asset issuer are all environment-supplied
with no default, so a misconfigured deployment fails loudly instead of silently
pointing at someone else's contract.

## Tests

Every count below was measured on 2026-09-10 by running the command above it.

```bash
cargo test
```

251 contract tests, no failures — 178 for the escrow contract and 73 for the
staking contract.

```bash
cd services/coordinator && npm test
```

2,235 coordinator unit tests passing, 3 skipped, 2,238 in total.

```bash
cd frontend && pnpm test
```

759 distinct frontend tests across 92 files. The runner prints **877**, because
`apps/web/vitest.config.ts` also includes `../../packages/*/src/**`, so the shared
`@lolipay/ui` (63) and `@lolipay/api-client` (55) suites execute twice — once
inside web's 412 and once as their own turbo tasks. Both numbers are given so that
the figure on this page matches what the command actually prints.

This count is not a promise that every run is green. Two cases in `apps/web` are
timing-sensitive under parallel load and fail intermittently; they are being
fixed. Everything else passes on every run we have measured. Note that `pnpm
test` is `turbo run test` with caching left on, so a second run can replay a
cached result without executing anything — reproduce the figure above with
`pnpm test -- --force`, or on a cold cache.

The coordinator's end-to-end tests need Postgres and MinIO. They are a separate
run because they need those services, not because they are optional:

```bash
cd services/coordinator
npm run e2e:up
npm run test:e2e
npm run e2e:down
```

443 end-to-end tests across 38 suites, no failures.

`npm run test:all` does the whole sequence and tears down afterwards. Both
services use tmpfs, so every run starts from an empty database.

The testnet integration suite is opt-in behind `RUN_TESTNET_IT` and takes its
contract ids from the environment.

## Security

Non-trivial invariants — the non-custodial boundary, escrow guarantees,
concurrency controls, and the fail-closed rules — are documented in
[SECURITY.md](SECURITY.md). If you believe you have found a vulnerability, please
report it privately rather than opening a public issue.

## Licence

[Apache-2.0](LICENSE).
