export function Nav() {
  return (
    <nav className="sticky top-0 z-20 border-b border-lp-line bg-lp-paper/80 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] max-w-[1200px] items-center justify-between px-7">
        <a href="#top" className="flex items-center gap-[9px] text-lp-ink no-underline">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-lp-accent">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="9" r="6.4" fill="#fff" />
              <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#fff" />
            </svg>
          </span>
          <span className="font-geist text-[22px] font-bold tracking-[-.02em]">lolipay</span>
        </a>
        <div className="hidden items-center gap-[30px] min-[720px]:flex">
          <a href="#how" className="text-[14.5px] font-medium text-lp-ink-soft no-underline">
            How it works
          </a>
          <a href="#features" className="text-[14.5px] font-medium text-lp-ink-soft no-underline">
            Features
          </a>
          <a href="#providers" className="text-[14.5px] font-medium text-lp-ink-soft no-underline">
            Providers
          </a>
        </div>
        {}
        <a
          href="https://app.lolipay.app"
          className="inline-flex items-center gap-[7px] rounded-xl bg-lp-ink px-[18px] py-2.5 text-sm font-semibold text-lp-paper no-underline"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="6" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M3 9h18M15 14h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          Connect wallet
        </a>
      </div>
    </nav>
  )
}
