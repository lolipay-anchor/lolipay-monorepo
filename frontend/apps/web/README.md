# lolipay web

The user-facing app: connect a Stellar wallet, buy or sell USDC for rupiah
through the escrow, follow an order, raise a dispute, and manage identity
verification and notifications. It is a Next.js app inside the `frontend/` pnpm
workspace and talks to the coordinator over its API; it never holds a key — the
wallet signs.

Routes: `/`, `/buy`, `/sell`, `/orders`, `/orders/[id]`, `/profile`,
`/notifications`.

## Running it

Dependencies come from the workspace, so install there first:

```bash
cd frontend
pnpm install
cd apps/web
PORT=3001 pnpm dev
```

`next dev` defaults to port 3000, which is also the coordinator's default port,
so run this app on 3001 — the port production serves it on, and the port the
Playwright configuration expects.

Copy `.env.example` to `.env.local` and fill it in. The names it declares:

| Name | What it is |
|---|---|
| `NEXT_PUBLIC_API_BASE` | the coordinator's base URL |
| `NEXT_PUBLIC_RPC_URL` | the Soroban RPC endpoint the wallet submits to |
| `NEXT_PUBLIC_HORIZON_URL` | the Horizon endpoint; defaults to the public testnet one |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | the Stellar network passphrase |
| `NEXT_PUBLIC_STELLAR_NETWORK` | the network name, used to build explorer links |
| `NEXT_PUBLIC_ESCROW_CONTRACT_ID` | the escrow contract |
| `NEXT_PUBLIC_USDC_CODE`, `NEXT_PUBLIC_USDC_ISSUER` | the settlement asset |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | WalletConnect, for mobile wallets |

No value in the template is a secret; every one is public configuration that
the browser receives.

## Tests

```bash
pnpm test
```

`vitest run`, over this app's own test files and — because
`vitest.config.ts` includes `../../packages/*/src/**` — the shared packages'
tests as well, so the same package tests also run under their own packages'
tasks when the workspace runs `pnpm test` at `frontend/`. The counts, with the
commit and date they were measured at, are in the root `README.md`.

Playwright specs live in `e2e/`, configured by `playwright.config.ts`, which
starts this app on port 3001 itself unless something already answers there, in
which case it tests that instead; there is no package script for them, so run
them with `npx playwright test`.

## Building

`pnpm build` runs `next build` and writes `.next/`. On lolipay's own host the
apps are served in place from the working tree, so a build there is a deploy
step, not a check. The live app also holds port 3001 on that host, so there
`PORT=3001 pnpm dev` fails to bind and `npx playwright test` tests the live app
rather than your working tree; run both on another machine.
