import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Nav } from '../../components/Nav'
import { Footer } from '../../components/Footer'
import { GET as stellarToml } from '../api/stellar-toml/route'

export const dynamic = 'force-dynamic'

const title = 'lolipay anchor — SEP-24 integration for wallet developers'
const description =
  "What lolipay's Stellar anchor publishes, what your wallet must support to complete a deposit and a withdrawal, and how to read the transaction record. Written for wallet engineers."

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    title,
    description,
    url: '/anchor',
    siteName: 'lolipay',
    type: 'website',
  },
}

const TOML_URL = 'https://lolipay.app/.well-known/stellar.toml'

const UNPUBLISHED = '—'

const MONO =
  'rounded-[6px] border border-lp-line bg-lp-raise px-1.5 py-0.5 font-geist-mono text-[12.5px] text-lp-ink'

async function servedToml(): Promise<string> {
  const response = await stellarToml()
  return response.status === 200 ? response.text() : ''
}

function declared(toml: string, key: string): string {
  const match = new RegExp(`^${key}=("?)(.*?)\\1$`, 'm').exec(toml)
  return match ? match[2] : UNPUBLISHED
}

function Band({ children }: { children: ReactNode }) {
  return (
    <section className="border-y border-lp-line bg-lp-raise">
      <div className="mx-auto max-w-[860px] px-7 py-16">{children}</div>
    </section>
  )
}

function Plain({ children }: { children: ReactNode }) {
  return (
    <section>
      <div className="mx-auto max-w-[860px] px-7 py-16">{children}</div>
    </section>
  )
}

function H2({ children }: { children: string }) {
  return (
    <h2 className="font-geist text-[clamp(25px,3.4vw,34px)] font-bold tracking-[-.03em]">{children}</h2>
  )
}

function H3({ children }: { children: string }) {
  return <h3 className="mt-10 font-geist text-[17.5px] font-bold tracking-[-.01em]">{children}</h3>
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-[13.5px] leading-[1.7] text-lp-ink-soft">{children}</p>
}

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-2.5 pl-0">
      {items.map((item) => (
        <li
          key={item}
          className="relative pl-5 text-[13.5px] leading-[1.65] text-lp-ink-soft before:absolute before:left-1 before:top-[9px] before:h-1 before:w-1 before:rounded-full before:bg-lp-accent"
        >
          {item}
        </li>
      ))}
    </ul>
  )
}

function Terminal({ lines }: { lines: string[] }) {
  return (
    <pre className="mt-4 overflow-x-auto rounded-[14px] border border-lp-line bg-lp-raise px-4 py-3.5 font-geist-mono text-[12.5px] leading-[1.75] text-lp-ink">
      {lines.join('\n')}
    </pre>
  )
}

function FieldList({
  id,
  caption,
  columns,
  rows,
}: {
  id: string
  caption: string
  columns: [string, string]
  rows: { term: string; detail: ReactNode }[]
}) {
  return (
    <div className="mt-8 overflow-hidden rounded-[20px] border border-lp-line bg-lp-surface">
      <div id={id} className="border-b border-lp-line bg-lp-raise px-5 py-3.5 font-geist text-[15px] font-bold">
        {caption}
      </div>
      <div className="hidden border-b border-lp-line px-5 py-2.5 font-geist-mono text-[11px] uppercase tracking-[.08em] text-lp-muted min-[720px]:grid min-[720px]:grid-cols-[14rem_1fr] min-[720px]:gap-5">
        <span>{columns[0]}</span>
        <span>{columns[1]}</span>
      </div>
      <dl className="m-0" aria-labelledby={id}>
        {rows.map((row) => (
          <div
            key={row.term}
            className="border-b border-lp-line px-5 py-4 last:border-b-0 min-[720px]:grid min-[720px]:grid-cols-[14rem_1fr] min-[720px]:gap-5"
          >
            <dt className="break-words font-geist-mono text-[13px] font-medium text-lp-accent-ink">
              {row.term}
            </dt>
            <dd className="m-0 mt-1.5 text-[13.5px] leading-[1.6] text-lp-ink-soft min-[720px]:mt-0">
              {row.detail}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export default async function AnchorPage() {
  const toml = await servedToml()
  const passphrase = declared(toml, 'NETWORK_PASSPHRASE')
  const status = declared(toml, 'status')
  const anchored = declared(toml, 'is_asset_anchored')

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <Nav />

      <header className="mx-auto max-w-[860px] px-7 pb-8 pt-14">
        <h1 className="font-geist text-[clamp(28px,4.4vw,42px)] font-bold tracking-[-.03em]">{title}</h1>
        <p className="mt-5 text-[15px] leading-[1.65] text-lp-ink-soft">{description}</p>
      </header>

      <Plain>
        <H2>The anchor, and the one document that describes it</H2>
        <P>
          {
            "lolipay is a peer-to-peer on and off ramp between Indonesian rupiah and USDC on Stellar. A person sends rupiah and receives USDC, or sends USDC and receives rupiah. The counterparty on the rupiah side is another person, a liquidity provider with their own collateral at stake, rather than a house account. There is no pooled anchor balance: each trade locks USDC in its own Soroban escrow, and that escrow's payout destinations are fixed when the trade is created."
          }
        </P>
        <P>Four SEPs carry the integration.</P>
        <Points
          items={[
            'SEP-1 Stellar Info File',
            'SEP-10 Stellar Web Authentication',
            'SEP-12 KYC API',
            'SEP-24 Hosted Deposit and Withdrawal',
          ]}
        />
        <P>One URL is enough to start:</P>
        <a
          href={TOML_URL}
          className="mt-4 block break-words rounded-[14px] border border-lp-line bg-lp-raise px-4 py-3.5 font-geist-mono text-[12.5px] leading-[1.6] text-lp-accent-ink no-underline"
        >
          {TOML_URL}
        </a>
        <P>
          Read the endpoints from that document rather than from this page. The toml is the authority for the
          network and the asset; read both from it.
        </P>
        <FieldList
          id="toml-publishes"
          caption="What stellar.toml publishes"
          columns={['Field', 'What it tells your wallet']}
          rows={[
            {
              term: 'NETWORK_PASSPHRASE',
              detail: (
                <>
                  {'The Stellar network this anchor operates on. It publishes the test network passphrase, '}
                  <code className={MONO}>{passphrase}</code>
                  {'. Sign every challenge and every Soroban call against the passphrase you read here.'}
                </>
              ),
            },
            {
              term: 'SIGNING_KEY',
              detail:
                "The account that sources and signs the SEP-10 challenge. Check it against the challenge transaction's own source account before you sign.",
            },
            {
              term: 'WEB_AUTH_ENDPOINT',
              detail: 'Where SEP-10 lives. GET it for a challenge; POST the signed challenge back for a token.',
            },
            { term: 'KYC_SERVER', detail: 'Where SEP-12 lives: GET, PUT and DELETE on /customer.' },
            {
              term: 'TRANSFER_SERVER_SEP0024',
              detail:
                'Where SEP-24 lives: /info, /transactions/deposit/interactive, /transactions/withdraw/interactive, /transactions and /transaction.',
            },
            {
              term: '[[CURRENCIES]] code and issuer',
              detail:
                'The asset to put in your list. The issuer published here issues the asset on the network published above; read it from the document rather than reusing an issuer you hold for another network.',
            },
            {
              term: '[[CURRENCIES]] status',
              detail: (
                <>
                  {"The asset's standing as this document declares it: "}
                  <code className={MONO}>{status}</code>
                  {'.'}
                </>
              ),
            },
            {
              term: 'is_asset_anchored',
              detail: (
                <>
                  {'Whether the asset is backed by an off-chain reserve. This document declares '}
                  <code className={MONO}>{anchored}</code>
                  {
                    ', and desc says the same in words: the asset itself is not redeemable and is not backed by anything.'
                  }
                </>
              ),
            },
          ]}
        />
      </Plain>

      <Band>
        <H2>What your wallet must be able to do, and where your token goes</H2>
        <p className="mt-4 text-[15px] font-medium leading-[1.6] text-lp-ink">
          Read this before you implement the withdrawal.
        </p>
        <P>
          {
            "lolipay's withdrawal does not use withdraw_anchor_account. There is no anchor Stellar account to pay: the USDC is locked in a per-trade Soroban escrow that the person signs inside the interactive page. SEP-24 tells a wallet to wait for pending_user_transfer_start before sending a payment to the anchor's account, and a lolipay withdrawal never reaches that status. A wallet that waits for it waits for a green light that does not arrive, and correctly sends nothing. withdraw_anchor_account, withdraw_memo and withdraw_memo_type are always null."
          }
        </P>
        <H3>What to build instead: open the interactive page and poll the record.</H3>
        <P>
          {
            "That signature happens in the interactive page's own browser context, so the page needs a wallet there that answers an injected request and response protocol over window.postMessage. It posts messages carrying source: 'FREIGHTER_EXTERNAL_MSG_REQUEST' and listens for source: 'FREIGHTER_EXTERNAL_MSG_RESPONSE' from the same window, asking for a connection, then an address, then a signature. Any wallet that answers that protocol completes a withdrawal. A withdrawal asks for two signatures on it, not one: the first locks the USDC in escrow, the second releases it once the rupiah has arrived."
          }
        </P>
        <P>
          {
            'The consequence to design around: if your wallet opens SEP-24 interactive URLs in an embedded webview with no injected provider, a deposit completes and a withdrawal cannot. The page tells the person so in words rather than failing silently, but it cannot finish there.'
          }
        </P>
        <P>
          {
            'Where your token goes on a deposit. A deposit credits the base Stellar account your SEP-10 token speaks for. The anchor splits a memo off the token subject and unwraps an M address to its G base before it sets to, and it publishes deposit_memo as null. If you are custodial and you attribute incoming payments by memo or by muxed sub-account, the payment lands on the base account with nothing to attribute it by: reconcile by the SEP-24 transaction id and the stellar_transaction_id on the record, never by memo.'
          }
        </P>
        <P>
          {
            'The destination has to exist already and hold a USDC trustline. /sep24/info publishes features.account_creation and features.claimable_balances; read them. An order opened for an account with no USDC trustline is refused as it is opened, with the reason in the response body, rather than stranding at settlement.'
          }
        </P>
        <H3>SEP-10, and the parts of it you cannot guess.</H3>
        <Points
          items={[
            "The challenge carries its own lifetime in the transaction's timebounds. Read it there rather than assuming a value.",
            'A challenge is single-use. Presenting the same one a second time is refused.',
            'An M muxed account is accepted as the account parameter.',
            'A memo is accepted as a 64-bit unsigned integer.',
            'A memo together with a muxed account is refused with a 400. The two are mutually exclusive.',
            'An account that exists on the network is verified against its own signers at its medium threshold, so a multisig wallet authenticates normally. An account that does not exist is verified against its own key.',
            "The token's subject is the account it speaks for, in one of three forms: the G address, G:memo when a memo was used, or the M address when a muxed account was used. Parse it; do not assume one form.",
            "client_domain and home_domain are accepted as parameters and are not honoured. The challenge is always built for this anchor's own home domain, and a home_domain this anchor does not serve returns a challenge rather than an error. Do not rely on either.",
          ]}
        />
        <P>
          {
            "What your token is scoped to. A SEP-10 token reaches the SEP-24 and SEP-12 surface and nothing else, held there by two mechanisms rather than by a list somebody maintains. Every authenticated route admits only the anchor's own session class by default, so a route accepts a SEP-10 token only where it names that class explicitly; and role resolution refuses to promote any class but session before it reads either the administrator list or the provider table. No configuration on this side widens a depositor's token."
          }
        </P>
        <P>
          {
            'min_amount and max_amount on /sep24/info are per transaction, and they are not the only limits that apply. When the anchor refuses, the reason is in the response body rather than in the status code alone. Read the body.'
          }
        </P>
      </Band>

      <Plain>
        <H2>Identity</H2>
        <P>
          {
            'Identity verification is required before a deposit trade can open, and it is performed by a third-party identity provider. Neither your wallet nor lolipay renders those screens: the person completes them inside the SEP-24 interactive page.'
          }
        </P>
        <P>
          {
            "Verification is bound to the verified person, not to the string in the token's subject. One completed verification authorises every Stellar account this anchor accepts for that person, and a memo or a muxed sub-account does not create a second identity to verify. If you are custodial and you model one end user per memo or per sub-account, this is where your model and this anchor's differ: those sub-accounts share one verification, and an erasure under any of them erases it for all."
          }
        </P>
        <P>SEP-12 lives at KYC_SERVER and every route needs a SEP-10 token.</P>
        <Points
          items={[
            'GET /customer returns what this anchor holds and what it still needs. It is where your wallet reads identity state; the SEP-24 transaction record also carries kyc_verified.',
            'PUT /customer accepts the fields it names and answers 202. The account and memo you send must match the ones your token speaks for, or it is refused.',
            'DELETE /customer/:account removes the verification this anchor holds for that person and clears the contact detail stored with it. One thing it does not remove: a refusal. The anchor keeps the fact that an identity was refused and clears its details.',
          ]}
        />
        <P>
          {
            'A refusal is final on this anchor. Once an identity is refused, sending the same details again is refused too, and the person is told so plainly rather than being left to retry. Your wallet does not need to poll for a refusal to clear, and should not offer the person a retry.'
          }
        </P>
      </Plain>

      <Band>
        <H2>The transaction record</H2>
        <FieldList
          id="deposit-statuses"
          caption="Deposit, and the statuses this anchor reports"
          columns={['status', 'What it means']}
          rows={[
            {
              term: 'incomplete',
              detail:
                'The interactive flow is open and no trade exists behind it. Nothing is committed and no money has moved.',
            },
            {
              term: 'pending_anchor',
              detail:
                'The anchor is working: matching a provider, or checking a rupiah transfer that has been reported. Nothing is being asked of the person.',
            },
            {
              term: 'pending_user_transfer_start',
              detail:
                "A provider is matched, the USDC is locked in escrow, and the person has been asked to send the rupiah to the provider's account. The destination is on the interactive page, not in this record: render message, which tells the person where to look, and keep that page reachable. user_action_required_by carries the deadline.",
            },
            {
              term: 'pending_external',
              detail:
                'The person has reported that the rupiah was sent, and the provider has been asked to confirm it against their own account. Render message, which tells the person not to send a second time.',
            },
            {
              term: 'completed',
              detail:
                "The escrow released and the net USDC is on the person's account. stellar_transaction_id and completed_at are set.",
            },
            {
              term: 'refunded',
              detail:
                'The trade closed without completing, and no USDC was sent to the person. It does not tell you whether the person sent the rupiah: the escrow can return to the provider either because the rupiah never arrived or because the provider did not confirm one that did. Render message, which tells the person to keep their transfer receipt. lolipay emits no refunds object and no amount_refunded, so there is no refund figure here to show anyone.',
            },
            {
              term: 'expired',
              detail:
                'The order closed before the escrow was funded, so no money moved and the person was never asked to send any: because they cancelled it, because it went stale before a provider funded it, or because this anchor stood the provider down. Nothing further happens on this transaction.',
            },
          ]}
        />
        <FieldList
          id="withdrawal-statuses"
          caption="Withdrawal, and the statuses this anchor reports"
          columns={['status', 'What it means']}
          rows={[
            {
              term: 'incomplete',
              detail:
                "The interactive flow is open and no trade exists behind it. No USDC has left the person's account.",
            },
            {
              term: 'pending_anchor',
              detail:
                'The anchor is working: the USDC is locked and the provider has been asked to send the rupiah. Nothing is being asked of the person.',
            },
            {
              term: 'pending_user',
              detail:
                'The person has something to sign or confirm in the interactive page, and this is the only status on which to send them back to it. message says which of the two signatures is being asked for, and user_action_required_by carries the deadline where there is one.',
            },
            {
              term: 'completed',
              detail:
                'The escrow released to the provider and the rupiah has been sent. stellar_transaction_id and completed_at are set.',
            },
            {
              term: 'refunded',
              detail:
                'The trade closed without completing, and the locked USDC returned to the person. stellar_transaction_id and completed_at describe that return. lolipay emits no refunds object and no amount_refunded.',
            },
            {
              term: 'expired',
              detail:
                "The order closed before the USDC was locked, so nothing left the person's account: because they cancelled it, because the signing window passed, or because this anchor stood the provider down. Nothing further happens on this transaction.",
            },
          ]}
        />
        <P>
          {
            'Three statuses appear in one direction only, and that absence is information rather than a gap: pending_user_transfer_start and pending_external are deposit-only, pending_user is withdrawal-only. Your wallet will not see them in the other direction.'
          }
        </P>
        <P>
          {
            "The same point in a trade does not map to the same status in both directions, which is why these are two tables and not one. The person's role reverses: on a withdrawal the person locks the USDC and the provider sends the rupiah, and on a deposit it is the other way round. So a point where a deposit reports pending_anchor can report pending_user on a withdrawal, and a point where a withdrawal reports pending_anchor can report pending_user_transfer_start on a deposit. Branch on kind before you branch on status."
          }
        </P>
        <P>
          {
            "Render message verbatim. It is the anchor's own instruction to the person, composed per transaction rather than per status: one status produces different sentences depending on which deadline has passed and whether the person has already reported a transfer. A wallet that writes its own copy from the status string will tell the person something false, such as that a transfer is still expected after the window closed, or that a deposit waits on them when it waits on a provider. Show message, and put your own copy around it rather than in place of it."
          }
        </P>
        <P>
          {
            "Three more things about the record. fee_details carries total and asset; amount_fee is deprecated in SEP-24 and this anchor does not emit it, so read amount_in, amount_out and fee_details, which are the three figures the person is agreeing to. stellar_transaction_id and completed_at appear on completed and on refunded, and both are nullable, so read them defensively rather than assuming a hash is there. Asset identifiers use the SEP-38 Asset Identification Format, because SEP-24 requires it: stellar:USDC:issuer on the USDC side and iso4217:currency on the rupiah side. lolipay does not serve SEP-38's quote endpoints."
          }
        </P>
      </Band>

      <Plain>
        <H2>Try it, and who to talk to</H2>
        <P>Four requests, no credentials, from a terminal. Start with the document:</P>
        <Terminal lines={['curl https://lolipay.app/.well-known/stellar.toml']} />
        <P>Then use the URLs you just read out of it:</P>
        <Terminal
          lines={[
            'curl "$TRANSFER_SERVER_SEP0024/info"',
            'curl "$WEB_AUTH_ENDPOINT?account=G..."',
            'curl "$TRANSFER_SERVER_SEP0024/transactions"',
          ]}
        />
        <P>
          {
            '/info returns the assets, the per-transaction limits and the features block. The challenge request returns a transaction as XDR. /transactions without a token answers 403, with this endpoint requires a SEP-10 token in the body; this anchor answers 403 there rather than 401, so match on the body and not on the code.'
          }
        </P>
        <P>
          {
            "The sequence stops at the challenge, because the next step is a signature and curl does not sign. Point your SDK's SEP-10 client at WEB_AUTH_ENDPOINT and it takes you the rest of the way."
          }
        </P>
        <P>
          {
            "If you are putting lolipay on a wallet's asset list, write to support@lolipay.app with the corridor you serve, the volume you expect, and the list you want it on. Those three are what tell us whether there is provider liquidity for what you need, and that is the part no document can answer."
          }
        </P>
      </Plain>

      <Footer />
    </div>
  )
}
