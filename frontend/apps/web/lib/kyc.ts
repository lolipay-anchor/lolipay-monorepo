export type KycFieldDescriptor = { type: string; description: string }

export type CustomerRecord = {
  id?: string
  status: 'NEEDS_INFO' | 'PROCESSING' | 'ACCEPTED' | 'REJECTED'
  message?: string
  fields?: Record<string, KycFieldDescriptor>
  provided_fields?: Record<string, KycFieldDescriptor>
}

export function splitProviderLink(message: string): [string, string | null, string] {
  const found = message.match(/https:\/\/[^\s;]+/)
  if (!found || found.index === undefined) return [message, null, '']
  return [
    message.slice(0, found.index),
    found[0],
    message.slice(found.index + found[0].length),
  ]
}
