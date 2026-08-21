export function TrustStrip() {
  return (
    <div className="border-y border-lp-line bg-lp-raise">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-x-10 gap-y-3.5 px-7 py-[18px] font-geist-mono text-[12.5px] uppercase text-lp-muted">
        <span className="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"
              className="stroke-lp-ink"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
          Non-custodial
        </span>
        <span className="flex items-center gap-2">
          <span className="flex h-[15px] w-[15px] items-center justify-center rounded-[4px] bg-lp-usdc text-[9px] font-bold text-white">
            $
          </span>
          USDC on Stellar
        </span>
        <span className="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M4 12h16"
              className="stroke-lp-ink"
              strokeWidth="1.7"
              strokeLinecap="round"
            />
          </svg>
          QRIS · UPI · PIX &amp; more
        </span>
        <span className="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="9" className="stroke-lp-ink" strokeWidth="1.7" />
            <path d="M12 7v5l3 2" className="stroke-lp-ink" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          Settles in ~2 min
        </span>
      </div>
    </div>
  )
}
