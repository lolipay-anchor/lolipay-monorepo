export function HowItWorks() {
  return (
    <section id="how">
      <div className="mx-auto max-w-[1200px] px-7 py-20">
        <div className="mx-auto mb-11 max-w-[620px] text-center">
          <div className="font-geist-mono text-xs uppercase tracking-[.14em] text-lp-accent-ink">How it works</div>
          <h2 className="mt-3 font-geist text-[clamp(28px,4vw,42px)] font-bold tracking-[-.03em]">
            Three taps to pay with crypto
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-[20px] border border-lp-line bg-lp-surface p-6">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-lp-accent-soft">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M4 12h16"
                    className="stroke-lp-accent-ink"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </div>
            <div className="mt-[18px] font-geist text-[19px] font-bold">Enter an amount</div>
            <p className="mt-2 text-sm leading-[1.55] text-lp-ink-soft">
              Type how much USDC to buy or sell. See the exact rate before you commit.
            </p>
          </div>
          <div className="rounded-[20px] border border-lp-line bg-lp-surface p-6">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-lp-green-soft">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <circle cx="9" cy="8" r="3" className="stroke-lp-green" strokeWidth="1.9" />
                  <path
                    d="M3.5 19c0-2.8 2.4-4.5 5.5-4.5s5.5 1.7 5.5 4.5"
                    className="stroke-lp-green"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </div>
            <div className="mt-[18px] font-geist text-[19px] font-bold">A provider takes it</div>
            <p className="mt-2 text-sm leading-[1.55] text-lp-ink-soft">
              Your USDC locks in on-chain escrow. A staked liquidity provider settles the local cash — you can
              see their reputation.
            </p>
          </div>
          <div className="rounded-[20px] border border-lp-line bg-lp-surface p-6">
            <div className="flex items-center justify-between">
              <span className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-lp-line-2">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M5 12l4 4 10-11"
                    className="stroke-lp-ink"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
            <div className="mt-[18px] font-geist text-[19px] font-bold">Settled on-chain</div>
            <p className="mt-2 text-sm leading-[1.55] text-lp-ink-soft">
              Once payment is confirmed, escrow releases on-chain. Fully pseudonymous — no name, no bank details
              shared.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
