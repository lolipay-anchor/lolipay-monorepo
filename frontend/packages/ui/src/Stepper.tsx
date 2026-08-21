import * as React from 'react'
type StepState = 'done' | 'now' | 'pending'
interface Step { label: string; state: StepState; at?: string }

const dotClass: Record<StepState, string> = {
  done:    'bg-lp-green border-lp-green',
  now:     'bg-lp-accent border-lp-accent',
  pending: 'bg-lp-surface border-lp-line',
}
const labelClass: Record<StepState, string> = {
  done:    'text-lp-muted line-through',
  now:     'text-lp-ink font-semibold',
  pending: 'text-lp-muted',
}

export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((step, i) => (
        <li key={i} className="flex items-start gap-3">
          <div className="flex flex-col items-center">
            <span className={`w-3 h-3 rounded-full border-2 mt-1 ${dotClass[step.state]}`} />
            {i < steps.length - 1 && <span className="w-0.5 flex-1 bg-lp-line min-h-[20px]" />}
          </div>
          <div className="pb-4">
            <span className={`text-sm ${labelClass[step.state]}`}>{step.label}</span>
            {step.at && <span className="block text-xs text-lp-muted">{step.at}</span>}
          </div>
        </li>
      ))}
    </ol>
  )
}
