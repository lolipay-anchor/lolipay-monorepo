export function Features() {
  return (
    <section id="features" className="border-y border-lp-line bg-lp-raise">
      <div className="mx-auto max-w-[1200px] px-7 py-20">
        <div className="mb-11 max-w-[560px]">
          <div className="font-geist-mono text-xs uppercase tracking-[.14em] text-lp-accent-ink">Features</div>
          <h2 className="mt-3 font-geist text-[clamp(28px,4vw,42px)] font-bold tracking-[-.03em]">
            Everything you need to move money
          </h2>
        </div>
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <path
                d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2"
                className="stroke-lp-accent-ink"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
              <path d="M4 12h16" className="stroke-lp-accent" strokeWidth="1.9" strokeLinecap="round" />
            </svg>
            <div className="font-geist text-[17px] font-bold">Cash out to your bank</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              Sell USDC and a liquidity provider sends rupiah straight to your bank or e-wallet.
            </p>
          </div>
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <path
                d="M8 4v13M8 17l-3-3M16 20V7M16 7l3 3"
                className="stroke-lp-ink"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="font-geist text-[17px] font-bold">Buy &amp; sell USDC</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              Top up from local currency or cash out to your bank at a transparent, live mid-market rate.
            </p>
          </div>
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <path
                d="M12 2l2.4 5 5.6.5-4.2 3.7 1.3 5.6L12 19l-5.1 2.8 1.3-5.6L4 12.5l5.6-.5L12 2z"
                className="fill-lp-amber"
              />
            </svg>
            <div className="font-geist text-[17px] font-bold">Rated providers</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              Every counterparty is staked and rated. See their track record before you trade.
            </p>
          </div>
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <rect x="4" y="10" width="16" height="10" rx="2.5" className="stroke-lp-green" strokeWidth="1.9" />
              <path d="M8 10V7a4 4 0 018 0v3" className="stroke-lp-green" strokeWidth="1.9" />
            </svg>
            <div className="font-geist text-[17px] font-bold">Escrow security</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              Funds sit in an on-chain contract — not with lolipay — and release only when the trade completes.
            </p>
          </div>
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <path
                d="M3 17l5-6 4 3 5-8"
                className="stroke-lp-accent-ink"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="font-geist text-[17px] font-bold">Live rates</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              Rates refresh every few seconds and lock for five minutes at checkout — no surprises.
            </p>
          </div>
          <div className="rounded-[18px] border border-lp-line bg-lp-surface p-[22px]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="mb-3.5">
              <circle cx="12" cy="8" r="4" className="stroke-lp-ink" strokeWidth="1.9" />
              <path
                d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"
                className="stroke-lp-ink"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
            <div className="font-geist text-[17px] font-bold">You hold the keys</div>
            <p className="mt-[7px] text-[13.5px] leading-[1.5] text-lp-ink-soft">
              No KYC to browse, no custody of your coins. Connect a wallet and go.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
