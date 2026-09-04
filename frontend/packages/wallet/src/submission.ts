export const SUBMISSION_WINDOW_CLOSED = 'This transaction expired before it reached the network. Try again to get a fresh one.'

type SendResult = { status: string; errorResult?: unknown }

function resultCode(errorResult: unknown): string | undefined {
  try {
    const holder = errorResult as { result?: unknown } | undefined
    const result = typeof holder?.result === 'function' ? (holder.result as () => unknown).call(holder) : holder?.result
    const union = result as { type?: unknown; switch?: () => { name?: unknown } } | undefined
    if (typeof union?.type === 'string') return union.type
    const name = typeof union?.switch === 'function' ? union.switch().name : undefined
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

export function submissionFailure(res: SendResult): string {
  const code = resultCode(res.errorResult)
  if (code === 'txTooLate') return SUBMISSION_WINDOW_CLOSED
  return `Submission failed (${res.status}${code ? `, ${code}` : ''})`
}
