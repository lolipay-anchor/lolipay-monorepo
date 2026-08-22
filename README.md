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
on-chain; the stake is slashable and bound to a genuinely disputed trade, so a
provider who takes fiat and does not deliver loses collateral. Settlement is
per-trade escrow, not a pooled float.

The result is an anchor that can be audited rather than trusted.

## What it does

Two ramps, both directions of the same escrow:

**Deposit** — the user pays rupiah to a matched provider. The provider's USDC is
already locked in escrow; once the user confirms payment, the contract releases
it to the user.

**Withdrawal** — the user locks USDC in escrow. The provider sends rupiah to the
user's bank or e-wallet, uploads proof, and the user's confirmation releases the
USDC to the provider.

Either party can raise a dispute while a trade is in flight, and for a bounded
window after it settles. A dispute freezes the trade and hands it to a resolver
who may choose release or refund — never a destination.

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

### The non-custodial boundary

The coordinator builds and simulates Soroban transactions, then returns them
**unsigned**. Whichever party the contract's `require_auth` names is the party
that signs, in their own wallet.

One server-side key exists. It pays transaction fees for the auto-refund cron and
nothing else: the escrow's `refund` is permissionless on-chain and can only return
funds to the original provider, so that key cannot redirect, release, resolve, or
dispute anything. It is structurally incapable of signing any other call — see
[SECURITY.md](SECURITY.md).

## Running it

Requires Node 22, Rust with the `wasm32v1-none` target, Docker, and Postgres.

```bash
# contracts
cargo test
cargo build --target wasm32v1-none --release

# coordinator
cd services/coordinator
cp .env.example .env          # fill in the values
docker compose up -d          # postgres + minio
npm ci && npx prisma db push
npm run start:dev

# frontend
cd frontend
pnpm install
pnpm dev
```

Each app has its own `.env.example`. No example file carries a live value: the
contract ids, the fee wallet, and the asset issuer are all environment-supplied
with no default, so a misconfigured deployment fails loudly instead of silently
pointing at someone else's contract.

## Tests

```bash
cargo test                              # 71 contract tests
cd services/coordinator && npm test     # 811 coordinator unit tests
cd frontend && pnpm test                # 650 frontend tests
```

The coordinator's 77 end-to-end tests need Postgres and MinIO. They are a
separate run because they need those services, not because they are optional:

```bash
cd services/coordinator
npm run e2e:up        # starts postgres + minio, applies the schema
npm run test:e2e      # 77 tests
npm run e2e:down
```

`npm run test:all` does the whole sequence and tears down afterwards. Both
services use tmpfs, so every run starts from an empty database.

The testnet integration suite is opt-in behind `RUN_TESTNET_IT` and takes its
contract ids from the environment.

## Status

Testnet. The escrow, staking, matching, dispute and settlement paths are built
and covered by the suites above. The SEP-1 / SEP-10 / SEP-12 / SEP-24 anchor
interface is in progress.

## Security

Non-trivial invariants — the non-custodial boundary, escrow guarantees,
concurrency controls, and the fail-closed rules — are documented in
[SECURITY.md](SECURITY.md). If you believe you have found a vulnerability, please
report it privately rather than opening a public issue.

## Licence

[Apache-2.0](LICENSE).
