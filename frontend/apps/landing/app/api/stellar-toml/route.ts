export const dynamic = 'force-dynamic'

const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015'

function toml(): string {
  return [`NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE}"`, ''].join('\n')
}

export async function GET(): Promise<Response> {
  return new Response(toml(), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  })
}
