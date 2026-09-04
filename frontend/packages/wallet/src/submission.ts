export const SIGNING_WINDOW_CLOSED =
  'The signing window for this order has closed, so the network refused the transaction; the order will expire on its own. Open it again for a fresh one.'

type SendResult = { status: string; errorResult?: unknown }

function resultCode(errorResult: unknown): string | undefined {
  const holder = errorResult as { result?: unknown } | undefined
  const result = typeof holder?.result === 'function' ? (holder.result as () => unknown).call(holder) : holder?.result
  const union = result as { type?: unknown; switch?: () => { name?: unknown } } | undefined
  if (typeof union?.type === 'string') return union.type
  const name = typeof union?.switch === 'function' ? union.switch().name : undefined
  return typeof name === 'string' ? name : undefined
}

export function submissionFailure(res: SendResult): string {
  const code = resultCode(res.errorResult)
  if (code === 'txTooLate') return SIGNING_WINDOW_CLOSED
  return `Submission failed (${res.status}${code ? `, ${code}` : ''})`
}
