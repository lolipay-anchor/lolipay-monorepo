export const IDENTITY_REQUIRED =
  'Verify your identity before your first trade. This app cannot start verification yet; a SEP-24 wallet such as the Stellar Demo Wallet can, using the same wallet address.'

const FALLBACK = 'The order could not be opened. Please try again.'

export const QUOTE_FALLBACK = 'Could not get a price right now. Please try again.'

const TRANSPORT = /→ \d{3}$|failed to fetch|networkerror|load failed|is not valid json|unexpected token|unexpected end of json/i

const PLAIN_WORDS: Array<[RegExp, string]> = [
  [/platform is paused/i, 'Trading is paused right now. Please try again later.'],
  [/no eligible LP available/i, 'No provider can take this order right now. Try again in a few minutes.'],
  [/outside current limits/i, 'This amount is outside the current limits. Try a different amount.'],
  [/daily limit exceeded/i, 'This order would go past your 24-hour limit. Try a smaller amount, or try again later.'],
  [/quote already used|quote.*expired/i, 'That price expired. Get a new quote and try again.'],
]

export function explainOrderRefusal(message: string, fallback: string = FALLBACK): string {
  if (/identity verification is required/i.test(message)) return IDENTITY_REQUIRED
  if (message.trim() === '' || TRANSPORT.test(message)) return fallback
  const known = PLAIN_WORDS.find(([pattern]) => pattern.test(message))
  return known ? known[1] : message
}
