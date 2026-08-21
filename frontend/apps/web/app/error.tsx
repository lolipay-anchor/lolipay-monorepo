'use client'

import * as React from 'react'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-lp-paper px-4 text-center gap-4">
      <div className="w-12 h-12 rounded-full bg-lp-danger-soft flex items-center justify-center">
        <span className="text-lp-danger text-xl font-bold">!</span>
      </div>
      <div>
        <h2 className="text-lg font-bold text-lp-ink mb-1">Something went wrong</h2>
        <p className="text-sm text-lp-ink-soft max-w-xs">{error.message}</p>
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-lp-cta bg-lp-ink px-6 py-3 font-geist text-[15px] font-semibold text-lp-paper transition"
      >
        Try again
      </button>
    </div>
  )
}
