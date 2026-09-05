export const IDENTITY_REQUIRED =
  'Verify your identity before your first trade. This app cannot start verification yet; a SEP-24 wallet such as the Stellar Demo Wallet can, using the same wallet address.'

const FALLBACK = 'The order could not be opened. Please try again.'

export function explainOrderRefusal(message: string): string {
  if (/identity verification is required/i.test(message)) return IDENTITY_REQUIRED
  return message.trim() === '' ? FALLBACK : message
}
