export function ProvidersCta() {
  return (
    <section id="providers">
      <div className="mx-auto max-w-[1200px] px-7 py-20">
        <div className="relative overflow-hidden rounded-[28px] bg-lp-ink p-[clamp(28px,5vw,56px)] text-lp-paper">
          <div
            aria-hidden="true"
            className="absolute -right-[60px] -top-[60px] h-[280px] w-[280px] animate-[lp-float_6s_ease-in-out_infinite] rounded-full bg-[radial-gradient(circle,theme(colors.lp-accent)_0%,transparent_70%)] opacity-45"
          />
          <div className="relative max-w-[560px]">
            <span className="inline-flex items-center gap-2 rounded-[20px] bg-white/[.12] px-3 py-1.5 font-geist-mono text-[11.5px] uppercase tracking-[.1em] text-lp-paper">
              For liquidity providers
            </span>
            <h2 className="mt-[18px] font-geist text-[clamp(26px,4vw,40px)] font-bold leading-[1.1] tracking-[-.03em]">
              Earn fees settling everyday payments
            </h2>
            <p className="mt-4 text-base leading-[1.6] opacity-75">
              Stake USDC as collateral, go online, and get matched with orders automatically. You choose the
              rails — bank, QRIS, UPI, PIX and more.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <a
                href="https://lp.lolipay.app"
                className="inline-flex items-center gap-2 rounded-[14px] bg-lp-accent px-6 py-3.5 text-[15px] font-semibold text-white no-underline"
              >
                Become a provider
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
              <span className="inline-flex items-center px-1 py-3.5 font-geist-mono text-[13px] opacity-60">
                lp.lolipay.app
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
