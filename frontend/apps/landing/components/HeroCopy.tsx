export function HeroCopy() {
  return (
    <div className="animate-lp-rise">
      <span className="inline-flex items-center gap-2 rounded-[20px] bg-lp-accent-soft px-[13px] py-1.5 text-[12.5px] font-semibold text-lp-accent-ink">
        <span className="h-1.5 w-1.5 animate-lp-pulse rounded-full bg-lp-accent" />
        Non-custodial · built on Stellar
      </span>
      <h1 className="mt-5 font-geist text-[clamp(40px,6vw,70px)] font-extrabold leading-[1.02] tracking-[-.035em]">
        Spend crypto
        <br />
        like it&apos;s <span className="text-lp-accent">nothing.</span>
      </h1>
      <p className="mt-5 max-w-[460px] text-[17px] leading-[1.6] text-lp-ink-soft">
        Buy and sell USDC with local cash, any time. A liquidity provider settles the rupiah leg;
        you keep your keys the whole way.
      </p>
      <div className="mt-[30px] flex flex-wrap gap-3">
        <a
          href="https://app.lolipay.app"
          className="inline-flex items-center gap-2 rounded-[14px] bg-lp-accent px-4 py-3.5 text-[15px] font-semibold text-white no-underline min-[720px]:px-6 min-[720px]:py-[15px]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="6" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M3 9h18M15 14h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Buy USDC
        </a>
        {}
        <a
          href="https://app.lolipay.app"
          className="inline-flex items-center gap-2 rounded-[14px] bg-lp-ink px-4 py-3.5 text-[15px] font-semibold text-lp-paper no-underline min-[720px]:px-6 min-[720px]:py-[15px]"
        >
          Connect wallet
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M5 12h14M13 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      </div>
      <div className="mt-[38px] flex flex-wrap items-center gap-x-7 gap-y-3">
        <div>
          <div className="font-geist text-[26px] font-bold text-lp-ink">100%</div>
          <div className="mt-0.5 text-[12.5px] text-lp-muted">non-custodial</div>
        </div>
        <div className="h-8 w-px bg-lp-line" />
        <div>
          <div className="font-geist text-[26px] font-bold text-lp-ink">~5s</div>
          <div className="mt-0.5 text-[12.5px] text-lp-muted">on-chain settlement</div>
        </div>
        <div className="h-8 w-px bg-lp-line" />
        <div>
          <div className="font-geist text-[26px] font-bold text-lp-ink">0</div>
          <div className="mt-0.5 text-[12.5px] text-lp-muted">funds we custody</div>
        </div>
      </div>
    </div>
  )
}
