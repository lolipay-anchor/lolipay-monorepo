import * as React from 'react'

export interface HoldToReleaseProps {
  label?: string; durationMs?: number; disabled?: boolean; onComplete: () => void; className?: string
}

export function HoldToRelease({ label = 'Hold to release', durationMs = 1000, disabled = false, onComplete, className = '' }: HoldToReleaseProps) {
  const [progress, setProgress] = React.useState(0)
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const fired = React.useRef(false)

  const stop = (reset: boolean) => {
    if (timer.current) { clearInterval(timer.current); timer.current = null }
    if (reset && !fired.current) setProgress(0)
  }
  const start = () => {
    if (disabled || fired.current || timer.current) return
    const t0 = Date.now()
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / durationMs)
      setProgress(p)
      if (p >= 1 && !fired.current) { fired.current = true; stop(false); onComplete() }
    }, 50)
  }
  const prevDisabled = React.useRef(disabled)
  React.useEffect(() => () => stop(false), [])
  React.useEffect(() => {
    if (disabled) {
      stop(true)
    } else if (prevDisabled.current) {
      fired.current = false
      setProgress(0)
    }
    prevDisabled.current = disabled
  }, [disabled])

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    if (event.repeat) return
    event.preventDefault()
    start()
  }
  const onKeyUp = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    stop(true)
  }

  return (
    <button type="button" disabled={disabled}
      onPointerDown={start} onPointerUp={() => stop(true)} onPointerLeave={() => stop(true)}
      onPointerCancel={() => stop(true)}
      onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={() => stop(true)}
      className={`relative w-full overflow-hidden rounded-lp-cta border border-lp-accent py-3.5 text-[15px] font-semibold text-lp-accent-ink disabled:cursor-not-allowed disabled:opacity-60 ${className}`}>
      <span data-testid="hold-fill" aria-hidden="true"
        className="absolute inset-y-0 left-0 bg-lp-accent-soft transition-none"
        style={{ width: `${progress * 100}%` }} />
      <span className="relative">{label}</span>
    </button>
  )
}
