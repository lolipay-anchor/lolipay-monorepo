# lolipay coordinator

How to run, configure and test the coordinator service. Everything here was
checked against the source at `main` commit `495f408`, the commit deployed on
2026-09-30; the containers recipe also depends on the env template as reformatted
after that commit.

## What this service is

A NestJS service that matches orders, prices quotes, indexes the escrow and
staking contracts, serves lolipay's own API and the anchor's SEP-10, SEP-12 and
SEP-24 endpoints, and builds the Soroban transactions that users and providers
sign in their own wallets. It returns those transactions **unsigned**.

It is not keyless. It holds three Stellar keys of its own — a refund fee-payer,
the fiat attestor and the SEP-10 signing key — and signs and submits with the
first two. What each key can and cannot do, and how they are held on the current
deployment, is stated once, in [`SECURITY.md`](../../SECURITY.md), and is not
repeated here. What the anchor can do for a person, with the evidence, is in the
root [`README.md`](../../README.md). The SEP-24 statuses it serves are the table
in [`ANCHOR-STATUS-MAPPING.md`](../../ANCHOR-STATUS-MAPPING.md), which mirrors
`src/sep24/sep24-status.ts` and nothing else.

## Environment

`.env.example` in this directory declares 44 names: every name the service reads
from the environment except the six `MINIO_*` names below, plus six that `src/`
does not read — the `POSTGRES_*` and `MINIO_ROOT_*` names the compose files read,
and `NODE_ENV`. Twenty-two of them carry a value, development defaults and public
testnet configuration such as the USDC issuer; the rest, the secrets among them,
are empty. Copy it to `.env` and fill it in.

Six more names are **not** in the template because the compose files supply
them: `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY` are required
(`src/config/app-config.service.ts`), and `MINIO_PORT`, `MINIO_USE_SSL` and
`MINIO_BUCKET` have defaults. The object store client is constructed at boot
(`src/storage/object-storage.service.ts`), so a host-side run without the first
three refuses to start with `Missing env MINIO_ENDPOINT`.

Names the service refuses to start without, or with a malformed value, as found
by reading its boot path — `src/main.ts`, the constructors and module factories
Nest runs while it builds the application, and the `onModuleInit` hooks —
grouped by where the refusal lives:

| Names | Where |
|---|---|
| `DATABASE_URL` | the container's start command, before migrations; on the host, `src/prisma/prisma.service.ts` |
| `JWT_SECRET` (32 characters or more), `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `PLATFORM_WALLET` (a G-address), `ALERT_WEBHOOK_URL` when it is set and is not an https URL | `src/config/app-config.service.ts` |
| `STELLAR_RPC_URL` (https, with a host and no userinfo), `ANCHOR_BASE_URL` (a plain https origin), `USDC_ASSET_CODE`, `USDC_ASSET_ISSUER`, `DIDIT_DAILY_SESSION_BUDGET` when it is set and is not a number of zero or more (unset, it is 200), `DIDIT_WEBHOOK_SECRET` when a verification provider is configured, `DIDIT_ENVIRONMENT` other than `live` on a public network (unset, it is `live`), `DIDIT_API_KEY` or `DIDIT_WORKFLOW_ID` absent on a public network, `PRICE_DEVIATION_MAX_BPS` unless it is strictly below the stored `Config.spreadBps` and, added to the stored `Config.platformFeeBps`, still strictly below that spread | `src/config/config-boot.service.ts` |
| `JWT_ISSUER` unless it is an absolute http(s) URI with no credentials (unset, it is `https://lolipay.app`; set but empty, it is refused) | `src/auth/jwt-options.ts`, reached from the constructor in `src/auth/jwt.strategy.ts` |
| `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `src/config/app-config.service.ts`, reached from the constructor in `src/storage/object-storage.service.ts` |
| `SEP10_SIGNING_KEY` when it is set and is not a Stellar secret seed, `ANCHOR_HOME_DOMAIN` and `SEP10_WEB_AUTH_DOMAIN` when set and not a bare host short enough that `<host> auth` fits in 64 characters | `src/sep10/sep10.service.ts` |

`STAKING_CONTRACT_ID` and `ESCROW_CONTRACT_ID` are required too, but nothing reads
them in a way that stops boot: the service starts without them, and whatever
reads one later fails with `Missing env …` (`src/config/app-config.service.ts`).

Names that change behaviour rather than gate boot, with their defaults where one
exists — a name below that also appears in the table can still stop boot, under
the condition the table gives it: `ADMIN_ADDRESSES` (comma-separated G-addresses
that hold the `admin` role; empty by default, and it is optional),
`STELLAR_READ_KEY` (a funded
**public** address used as the source of read-only simulations; optional for boot
only, because the service loads that key's account to build every read-only
contract simulation and otherwise falls back to a random key whose account does
not exist, so without a funded key every such simulation fails),
`JWT_TTL_SECONDS` (900), `AUTH_CHALLENGE_TTL_SECONDS` (120),
`PRICE_STALE_SECONDS` (120),
`SEP24_WITHDRAW_ENABLED` (`false`; `true` in production), `KYC_REQUIRE_AML`
(`true`), `HORIZON_URL` (the public testnet Horizon), `PORT` (3000),
`CORS_ORIGINS` (unioned with lolipay's own four origins), `ALERT_WEBHOOK_URL`,
`HEARTBEAT_STALE_SECONDS`, `RESEND_API_KEY` and `RESEND_FROM`, the three key
seeds `ATTESTOR_SECRET`, `REFUND_SIGNER_SECRET` and `SEP10_SIGNING_KEY`, and the
rest of the template's names that the service reads.

`COINGECKO_API_KEY`, which an earlier edition of this file documented, is read by
nothing in `src/` and is not in this template.

## Running locally

**Everything in containers** — Postgres, MinIO and the service, with the
migrations applied by the container before it listens:

```bash
[ -f .env ] || cp .env.example .env
```

Before starting it, fill in `.env`: every name the template leaves empty that the
table above refuses to start without — `JWT_SECRET`, `PLATFORM_WALLET` and
`ANCHOR_BASE_URL` — and the two contract ids. In `DATABASE_URL`, replace the
template's placeholder password `CHANGE_ME` with `lolipay`, the development
password `docker-compose.yml` sets for its Postgres, or the database refuses the
login.

```bash
docker compose up -d
curl --retry 10 --retry-all-errors --retry-delay 2 http://localhost:3000/health
```

`GET /health` answers `{"status":"ok"}`. The service is published on
`127.0.0.1:3000`. If the coordinator exited on its first start — its migrations
can run before Postgres accepts connections — run `docker compose up -d` again.

**The service on the host** is not set up by the tracked files. The compose file
publishes Postgres on `127.0.0.1:5432` but publishes no port for `minio`, so a
host process cannot reach the object store the compose stack runs, and the
tracked template does not carry the six `MINIO_*` names. The template's
`DATABASE_URL` also names the compose service `postgres` as its host, which
resolves only inside the compose network, and carries a placeholder password, so
the recipe below exports its own, pointed at the published port; a name already
exported in the shell takes precedence over `.env`, for `prisma` and for the
service alike. To run on the host you need a
MinIO the host can reach — publish the compose service's port 9000 yourself, or
run one of your own — and then, without starting the `coordinator` container (it
would take port 3000 first):

```bash
[ -f .env ] || cp .env.example .env
```

Fill in `.env` as above; its `DATABASE_URL` does not matter for this run, because
the recipe exports its own. The file must exist before `docker compose` runs,
which refuses to load the project without it.

```bash
docker compose up -d postgres minio
npm ci
npx prisma generate
export DATABASE_URL="postgresql://lolipay:lolipay@127.0.0.1:5432/lolipay?schema=public"
npx prisma migrate deploy
export MINIO_ENDPOINT=<host the service can reach> MINIO_PORT=9000 MINIO_USE_SSL=false MINIO_ACCESS_KEY=lolipay MINIO_SECRET_KEY=lolipaydev MINIO_BUCKET=lolipay-uploads
npm run start:dev
```

The database user, password and name in `DATABASE_URL`, and the access key,
secret and bucket, are the development values from `docker-compose.yml`.
`npx prisma generate` writes the database client to `src/generated/prisma`,
which is not checked in, so a fresh checkout does not compile without it. The
schema is applied from the numbered migrations in
`prisma/migrations` with
`prisma migrate deploy`, which is what `npm run db:deploy`, the e2e stack and the
production container all run; `prisma db push` is not used anywhere in this
repository, because it bypasses the migration history.

Production runs from `docker-compose.prod.yml`, which reads the same `.env` and
supplies the same six `MINIO_*` names.

## Endpoints

Every route, with what it requires. "Session" is the app's own JWT from
`POST /auth/verify`; "SEP-10 token" is the JWT from the SEP-10 exchange, which
the same guard accepts and which resolves to the `user` role. Roles are
re-derived from the database on every request.

### Public, no token

| Method | Path | What it is |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/rate` | the current corridor rate |
| GET | `/markets` | the corridors and their limits |
| GET | `/sep24/info` | SEP-24 capabilities |
| GET | `/auth?account=G…` | SEP-10 challenge; asking for one writes nothing |
| POST | `/auth` | SEP-10 challenge exchange; the only route that accepts a signed transaction, and it verifies, never signs |
| POST | `/webhooks/didit` | the verification provider's deliveries, HMAC-checked |
| GET | `/sep24/more-info/:id` | a SEP-24 transaction's human-readable status page, by its id; for a funded deposit inside its pay window and not yet reported paid it shows the provider's payment details — see `SECURITY.md` |

### App login (SEP-53 wallet authentication)

| Method | Path | What it is |
|---|---|---|
| POST | `/auth/challenge` | issue a self-verifying nonce for a wallet address |
| POST | `/auth/verify` | verify the wallet's signature over it, return a session |

Both are limited to 30 requests per minute per IP.

### SEP-12 (SEP-10 token)

| Method | Path | What it is |
|---|---|---|
| GET | `/customer` | the verification status for the token's person |
| PUT | `/customer` | submit the identity fields; opens a session with the verification provider |
| DELETE | `/customer/:account` | erasure; a refused verification is redacted and retained |

### SEP-24 (SEP-10 token for the transaction endpoints; the interactive pages carry their own credential, issued when the transaction is opened)

| Method | Path | What it is |
|---|---|---|
| POST | `/sep24/transactions/deposit/interactive` | open a deposit |
| POST | `/sep24/transactions/withdraw/interactive` | open a withdrawal (`SEP24_WITHDRAW_ENABLED`) |
| GET | `/sep24/transactions`, `/sep24/transaction` | the token's transactions, one transaction |
| GET | `/sep24/interactive/:id` | the interactive page |
| POST | `/sep24/interactive/:id/identity`, `/amount`, `/paid` | the identity fields, the amount, the user's claim to have paid |
| GET | `/sep24/interactive/:id/fund-tx`, `/release-tx`, `/fund.js`, `/release.js` | the unsigned withdrawal funding and release transactions, and the page scripts that sign and submit them from the browser |

### Quotes and orders (session)

| Method | Path | Roles | What it is |
|---|---|---|---|
| POST | `/quotes` | any | a server-computed quote; 10 per minute per IP |
| POST | `/orders` | any | create an order from a quote; refused until the person's identity is accepted and screened |
| GET | `/orders` | any | the caller's orders |
| GET | `/orders/:id` | any, party-gated | the user or the matched provider only; anyone else, an administrator included, gets 403 |
| POST | `/orders/:id/cancel` | any | only before the escrow is funded |
| GET | `/orders/:id/tx/create-trade` | any | unsigned `create_trade` for the funding party |
| GET | `/orders/:id/tx/mark-paid` | any | unsigned `mark_fiat_paid` for the paying party |
| GET | `/orders/:id/tx/confirm-release` | any | unsigned `confirm_and_release` for the confirmer |
| GET | `/orders/:id/tx/raise-dispute` | any | unsigned `raise_dispute` |
| POST | `/orders/:id/dispute` | any | record the dispute off chain |
| GET, POST | `/orders/:id/dispute-evidence` | any, attribution-checked | evidence download and upload |
| POST | `/orders/:id/proof` | `lp`, `admin` | the provider's transfer proof |
| GET | `/orders/:id/proof` | any, party-gated | download it |
| GET, POST | `/orders/:id/confirm-receipt` | any | the message to sign, and the provider's wallet-signed receipt that makes the attestor mark a deposit paid |
| GET | `/orders/:id/tx/resolve` | `admin` | unsigned `resolve` for the resolver |
| GET | `/orders/:id/slash-state`, `/orders/:id/tx/slash` | `admin` | the slash view and the unsigned `slash` for the resolver or administrator |

### Liquidity providers (session)

| Method | Path | Roles | What it is |
|---|---|---|---|
| POST | `/lp/apply` | any | apply to become a provider |
| GET | `/lp/me` | any | the caller's provider record |
| PATCH | `/lp/me` | `lp` | update it |
| GET | `/lp/eligibility` | any | whether the caller may provide |
| GET | `/lp/earnings` | `lp` | earnings |
| POST | `/lp/heartbeat` | `lp` | liveness |
| POST | `/lp/availability` | `lp` | go online or offline (this was documented as `PATCH` in an earlier edition; it has always been `POST`) |
| POST, PATCH, DELETE | `/lp/payment-methods`, `/lp/payment-methods/:id` | `lp` | the accounts depositors are told to pay; session-only, no wallet signature — see `SECURITY.md` |
| GET | `/lp/tx/stake` | `lp` | unsigned `stake` |
| GET | `/lp/tx/request-unstake`, `/lp/tx/claim-unstake` | any | unsigned `request_unstake`, `claim_unstake` |
| GET | `/lp/assignments` | `lp`, `admin` | the provider's trades, with payment instructions where the provider is the payer |

### Administration (session, `admin`)

| Method | Path | What it is |
|---|---|---|
| GET, POST | `/admin/lps` | list providers; register one |
| POST | `/admin/lps/:id/approve`, `/suspend`, `/revoke` | change a provider's status |
| GET | `/admin/orders`, `/admin/orders/:id/risk` | orders; one order's risk view |
| POST | `/admin/orders/:id/attest` | make the attestor mark a deposit paid on the administrator's word — the rescue path |
| GET | `/admin/metrics/overview` | operational metrics |
| GET | `/metrics` | order counts by status, overdue and disputed orders, and the indexer's lag; outside the `/admin` prefix, with the same `admin` role |
| GET, PATCH | `/admin/config` | the platform configuration |
| GET, PATCH | `/admin/markets`, `/admin/markets/:code` | the corridors |

### Notifications and profile (session)

| Method | Path | What it is |
|---|---|---|
| GET | `/notifications` | the caller's notifications |
| POST | `/notifications/read` | mark read |
| GET | `/profile` | the caller's reputation tier, and its daily limit, used and remaining |

Routes an earlier edition of this file listed that do not exist:
`POST /orders/:id/confirm-payment` and `POST /orders/:id/release`. The paying and
confirming parties build and sign `tx/mark-paid` and `tx/confirm-release`
instead.

## Rate limiting

A global limit of **60 requests per 60 s per IP** applies to every route
(`src/app.module.ts`), and a route's own `@Throttle` replaces it where present:
30 per minute on the two app-login routes, 10 per minute on `POST /quotes`, 120
per minute on the two SEP-10 routes, 30 per minute on `GET /rate`, `GET /markets`
and `GET /sep24/info`, 40 per hour on `PUT /customer`, and per-route limits on
the SEP-24 pages that are read in `src/sep24/sep24.controller.ts`. Exceeding a
limit answers HTTP 429. An earlier edition of this file gave the app-login limit
as 10 per minute; it has been 30 since the day that edition was written.

## Scheduled work

`grep -rn '@Cron' src` lists them: the on-chain indexer every 10 s; the outbox
that delivers notifications, emails and alerts every 30 s; every 5 min the
automatic refund (`autoRefundExpired`, which submits with the refund fee-payer),
order expiry (`expireStaleOrders`), the escrow configuration drift check and the
monitoring sweep that raises the alerts named in `SECURITY.md`; every 10 min the
escrow divergence check and the orphaned-escrow reconciliation; every hour the
prune of old quotes and spent nonces.

## Tests

Unit tests, no database:

```bash
npm ci
npx prisma generate
npm test
```

End-to-end tests need Postgres and MinIO. They run against their own compose
project on fixed host ports, so one e2e run at a time on a machine:

```bash
npm run e2e:up
npm run test:e2e
npm run e2e:down
```

`e2e:up` starts `docker-compose.e2e.yml` under the project name `lolipay-e2e`
and applies the migrations; `e2e:down` removes it with its volumes. Both stores
use tmpfs, so every run starts empty. `npm run test:all` runs the unit tests,
then the whole e2e sequence, and tears down afterwards.

The testnet integration suite is opt-in and reads its inputs from the
environment — `IT_ESCROW_CONTRACT_ID`, `IT_STAKING_CONTRACT_ID` and
`IT_READ_KEY`, none of which is in any template:

```bash
RUN_TESTNET_IT=1 IT_ESCROW_CONTRACT_ID=C… IT_STAKING_CONTRACT_ID=C… IT_READ_KEY=G… npx jest stellar-read.integration
```

Without `RUN_TESTNET_IT` the suite's three tests are skipped, which is the one
skipped suite in `npm test`. It checks that the real RPC decodes the staking
eligibility flag and a trade's status; if the network is unreachable it warns
and soft-skips rather than failing.

The SDF acceptance suite has scripts here too — `npm run anchor:test:sep1`,
`sep10`, `sep12`, `sep24`. All four point at `lolipay.app`, the live anchor,
unless `ANCHOR_TEST_DOMAIN` names another, and every one but `sep1` writes to the
anchor it is pointed at: a SEP-10 run records the challenge nonces it redeems and
creates an empty person record and a wallet-link record for each throwaway
keypair it signs in with; the SEP-12 run opens verification sessions with the
outside provider, and the SEP-24 run creates transaction records. Those two also
need a `--sep-config` file.
`sep24` reads `anchor-tests/sep-config.local.json`, which is not tracked;
`src/scripts/sep24-fixtures.ts` writes it.

The counts these suites print, with the commit and date they were measured at,
are in the root `README.md` and are not repeated here.

## Build

```bash
npm run build
```

`nest build` writes `dist/`, which the container starts with
`npx prisma migrate deploy && node dist/main.js`.
