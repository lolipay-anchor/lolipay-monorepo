import * as React from 'react'

export interface CountdownProps {
  deadline: number; onExpire?: () => void; warnUnderSecs?: number; className?: string
}

export function Countdown({ deadline, onExpire, warnUnderSecs = 60, className = '' }: CountdownProps) {
  const calc = () => Math.max(0, Math.floor((deadline - Date.now()) / 1000))
  const [left, setLeft] = React.useState(calc)

  const onExpireRef = React.useRef(onExpire)
  React.useEffect(() => {
    onExpireRef.current = onExpire
  }, [onExpire])

  React.useEffect(() => {
    let fired = false
    const fireOnce = () => {
      if (!fired) {
        fired = true
        onExpireRef.current?.()
      }
    }

    const initial = Math.max(0, Math.floor((deadline - Date.now()) / 1000))
    setLeft(initial)
    if (initial === 0) {
      fireOnce()
      return
    }

    const id = setInterval(() => {
      const s = Math.max(0, Math.floor((deadline - Date.now()) / 1000))
      setLeft(s)
      if (s === 0) {
        clearInterval(id)
        fireOnce()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [deadline])

  const m = Math.floor(left / 60)
  const s = String(left % 60).padStart(2, '0')
  return (
    <span className={`font-geist-mono tabular-nums ${left < warnUnderSecs ? 'text-lp-danger' : 'text-lp-ink'} ${className}`}>
      {m}:{s}
    </span>
  )
}
