export function Footer() {
  return (
    <footer className="border-t border-lp-line bg-lp-raise">
      <div className="mx-auto max-w-[1200px] px-7 pb-10 pt-14">
        <div className="grid grid-cols-2 gap-7 min-[900px]:grid-cols-[1.4fr_1fr_1fr_1fr] min-[900px]:gap-8">
          <div>
            <div className="flex items-center gap-[9px]">
              <span className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-lp-accent">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="9" r="6.4" fill="#fff" />
                  <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#fff" />
                </svg>
              </span>
              <span className="font-geist text-xl font-bold">lolipay</span>
            </div>
            <p className="mt-3.5 max-w-[260px] text-[13.5px] leading-[1.55] text-lp-muted">
              Non-custodial payments on Stellar. Spend crypto like it&apos;s nothing.
            </p>
          </div>
          <div>
            <div className="mb-3 font-geist-mono text-xs uppercase tracking-[.08em] text-lp-muted">Product</div>
            <div className="flex flex-col gap-[9px] text-sm">
              <a href="https://app.lolipay.app" className="text-lp-ink-soft no-underline">
                app.lolipay.app
              </a>
              <a href="https://lp.lolipay.app" className="text-lp-ink-soft no-underline">
                lp.lolipay.app
              </a>
            </div>
          </div>
          <div>
            <div className="mb-3 font-geist-mono text-xs uppercase tracking-[.08em] text-lp-muted">Learn</div>
            <div className="flex flex-col gap-[9px] text-sm">
              <a href="#how" className="text-lp-ink-soft no-underline">
                How it works
              </a>
              <a href="#features" className="text-lp-ink-soft no-underline">
                Features
              </a>
              <a href="#providers" className="text-lp-ink-soft no-underline">
                For providers
              </a>
            </div>
          </div>
          <div>
            <div className="mb-3 font-geist-mono text-xs uppercase tracking-[.08em] text-lp-muted">Legal</div>
            <div className="flex flex-col gap-[9px] text-sm">
              <a href="#" className="text-lp-ink-soft no-underline">
                Terms
              </a>
              <a href="#" className="text-lp-ink-soft no-underline">
                Privacy
              </a>
              <a href="#" className="text-lp-ink-soft no-underline">
                Risk notice
              </a>
            </div>
          </div>
        </div>
        <div className="mt-11 flex flex-wrap items-center justify-between gap-3 border-t border-lp-line pt-[22px] text-[12.5px] text-lp-muted">
          <span>© 2026 lolipay. Not a bank. USDC ⇄ IDR is provided peer-to-peer.</span>
          <span className="font-geist-mono">Built on Stellar</span>
        </div>
      </div>
    </footer>
  )
}
