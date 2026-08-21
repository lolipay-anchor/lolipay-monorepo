# lolipay Trade Coordinator

How to run, configure, and test the coordinator service. The coordinator matches
orders and builds unsigned transactions; it never holds funds or signing keys.

---

## What this service is

The lolipay coordinator is a **fully non-custodial** backend. It never holds
private keys or seeds. Clients (Freighter wallet in the browser) sign all
on-chain transactions. The coordinator only:

- Issues JWT challenges (SEP-53 wallet-auth).
- Computes quotes server-side (fiat amount, fees).
- Coordinates LP matching and order state.
- Reads on-chain escrow/staking contract state via `simulateTransaction`
  (read-only, no signing, no submission).

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `JWT_SECRET` | yes | Random secret for JWT signing (min 32 chars) |
| `STELLAR_RPC_URL` | yes | Soroban RPC endpoint (testnet: `https://soroban-testnet.stellar.org`) |
| `STELLAR_NETWORK_PASSPHRASE` | yes | `Test SDF Network ; September 2015` (testnet) |
| `STAKING_CONTRACT_ID` | yes | Deployed staking contract address (C...) |
| `ESCROW_CONTRACT_ID` | yes | Deployed escrow contract address (C...) |
| `ADMIN_ADDRESSES` | yes | Comma-separated G-addresses that have the `admin` role |
| `PLATFORM_WALLET` | yes | G-address that receives platform fees |
| `STELLAR_READ_KEY` | optional | Any funded G-address (public key only, never a seed) used as the `simulateTransaction` source, so the RPC does not reject reads from an unknown account |
| `JWT_TTL_SECONDS` | optional | JWT lifetime (default: 900) |
| `AUTH_CHALLENGE_TTL_SECONDS` | optional | Nonce TTL (default: 120) |
| `PRICE_STALE_SECONDS` | optional | CoinGecko cache TTL (default: 120) |
| `PRICE_DEVIATION_MAX_BPS` | optional | Max rate deviation guard (default: 500 = 5%) |
| `COINGECKO_API_KEY` | optional | CoinGecko Pro API key |
| `PORT` | optional | HTTP port (default: 3000) |

---

## Running locally

### 1. Start Postgres

```bash
sudo docker compose up -d postgres
```

### 2. Push schema

```bash
DATABASE_URL="postgresql://lolipay:lolipay@localhost:5432/lolipay?schema=public" \
  npx prisma db push --skip-generate
```

### 3. Start the service

```bash
cp .env.example .env
# Fill in: JWT_SECRET, ADMIN_ADDRESSES, PLATFORM_WALLET, STAKING_CONTRACT_ID,
#          ESCROW_CONTRACT_ID, STELLAR_RPC_URL, STELLAR_NETWORK_PASSPHRASE
npm run start:dev
```

### 4. Smoke test

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

---

## Endpoints

### Auth (wallet-auth, SEP-53)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/challenge` | none | Issue a nonce for the given wallet address |
| POST | `/auth/verify` | none | Verify signed nonce, return JWT |

Rate limit: 10 requests / 60 s per IP (brute-force protection).

### Quotes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/quotes` | JWT | Get a rate quote (server-computed, fiat amount is authoritative) |

Rate limit: 10 requests / 60 s per IP.

### LP (liquidity provider)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/lp/apply` | JWT | Apply to become an LP |
| PATCH | `/lp/availability` | JWT (LP) | Toggle availability |
| POST | `/lp/payment-methods` | JWT (LP) | Add a payment method |
| PATCH | `/lp/payment-methods/:id` | JWT (LP) | Update a payment method |

### Orders

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/orders` | JWT | Create order from a quote |
| GET | `/orders/:id` | JWT | Get order (party-gated: buyer/seller/platform) |
| POST | `/orders/:id/confirm-payment` | JWT (buyer) | Mark fiat sent |
| POST | `/orders/:id/release` | JWT (seller) | Release USDC after fiat confirmed |
| POST | `/orders/:id/cancel` | JWT | Cancel (only pre-FUNDED) |

### Admin

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/lps` | JWT (admin) | List LPs (filter by status) |
| POST | `/admin/lps/:id/approve` | JWT (admin) | Approve LP application |
| POST | `/admin/lps/:id/suspend` | JWT (admin) | Suspend LP |
| POST | `/admin/lps/:id/revoke` | JWT (admin) | Revoke LP |
| GET | `/admin/config` | JWT (admin) | Read platform config |
| PATCH | `/admin/config` | JWT (admin) | Update config (fees, limits, pause) |

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Liveness check |

---

## Rate limiting

Global: **60 requests / 60 s** per IP (all routes).
Tighter: **10 requests / 60 s** on `/auth/challenge`, `/auth/verify`, and `POST /quotes`.

Returns HTTP 429 when exceeded.

---

## Running tests

### Unit tests (offline, no DB)

```bash
npm test
```

### E2E tests (requires Postgres)

```bash
sudo docker compose up -d postgres
DATABASE_URL="postgresql://lolipay:lolipay@localhost:5432/lolipay?schema=public" \
  npx prisma db push --skip-generate
npm run test:e2e
```

### Testnet integration test (opt-in, requires network)

Verifies the real Soroban RPC and contract decoding (Status enum index→label map):

```bash
RUN_TESTNET_IT=1 npx jest stellar-read.integration
```

Expected output:
- `isEligible`: returns `boolean` (staking contract `is_eligible` decoded).
- `getTradeStatus(known)`: `{ status: 'RELEASED' }` or `null` (if TTL-archived).
- `getTradeStatus(random)`: `null` (non-existent trade).

If the network is unreachable (sandbox), `isEligible` emits a warning and soft-skips;
`getTradeStatus` returns `null` (catches all errors internally).

### Build

```bash
npm run build
```

---

## Security notes

- **Non-custodial**: this service holds no private keys. `STELLAR_READ_KEY` is a
  funded **public key** (G-address) only — used to load the account for
  `simulateTransaction`. It is never used to sign anything.
- All JWT secrets and API keys are env vars; never committed.
- Roles (`admin`, `lp`) are enforced server-side via guards on every protected route.
- Quote amounts are computed server-side; client-supplied `fiat_amount` is ignored.
- Trade IDs are 32-byte random hex to prevent enumeration.
