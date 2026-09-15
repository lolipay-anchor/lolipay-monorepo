import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

const mockRequest = vi.hoisted(() => vi.fn())
vi.mock('@/lib/client', () => ({ client: { request: mockRequest } }))

const { IdentityCard } = await import('@/components/IdentityCard')
const { splitProviderLink } = await import('@/lib/kyc')

const FIELDS = {
  first_name: { type: 'string', description: 'given name as it appears on the identity document' },
  last_name: { type: 'string', description: 'family name as it appears on the identity document' },
  email_address: { type: 'string', description: 'an address that can receive verification mail' },
  id_type: { type: 'string', description: 'the kind of identity document being presented' },
  id_country_code: { type: 'string', description: 'ISO 3166-1 alpha-3 code of the issuing country' },
}

const OPEN_AT_PROVIDER =
  'this verification is open at the provider — complete it at https://verify.didit.me/s/abc123; if it has expired, submit your details again after a day and a new one will be opened'

const AWAITING_SCREENING =
  'identity checks passed, but the sanctions screening this anchor requires has not been completed, so no trade can be opened yet'

function answering(get: unknown) {
  mockRequest.mockImplementation(async (method: string) => {
    if (method === 'GET') return get
    return { id: 'GDCP' }
  })
}

function mount() {
  return render(
    <TestProviders>
      <IdentityCard />
    </TestProviders>,
  )
}

describe('the identity card is this app’s own door to verification', () => {
  beforeEach(() => {
    sessionStorage.clear()
    sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
    queryClient.clear()
    mockRequest.mockReset()
  })

  it('asks the anchor what it holds about this customer', async () => {
    answering({ status: 'NEEDS_INFO', fields: FIELDS })
    mount()
    await screen.findByTestId('identity-card')
    expect(mockRequest).toHaveBeenCalledWith('GET', '/customer')
  })

  it('builds the form from the fields the anchor asked for, never from a list this app invented', async () => {
    answering({ status: 'NEEDS_INFO', fields: FIELDS })
    mount()
    await screen.findByTestId('identity-form')
    for (const name of Object.keys(FIELDS)) {
      expect(document.querySelector(`input[name="${name}"]`)).toBeTruthy()
    }
    expect(document.querySelectorAll('#identity-form-fields input').length).toBe(5)
  })

  it('sends exactly what was typed to PUT /customer', async () => {
    answering({ status: 'NEEDS_INFO', fields: FIELDS })
    mount()
    await screen.findByTestId('identity-form')

    fireEvent.change(document.querySelector('input[name="first_name"]')!, { target: { value: 'Budi' } })
    fireEvent.change(document.querySelector('input[name="last_name"]')!, { target: { value: 'Santoso' } })
    fireEvent.change(document.querySelector('input[name="email_address"]')!, { target: { value: 'budi@example.com' } })
    fireEvent.change(document.querySelector('input[name="id_type"]')!, { target: { value: 'id_card' } })
    fireEvent.change(document.querySelector('input[name="id_country_code"]')!, { target: { value: 'IDN' } })

    fireEvent.submit(screen.getByTestId('identity-form'))

    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('PUT', '/customer', {
        first_name: 'Budi',
        last_name: 'Santoso',
        email_address: 'budi@example.com',
        id_type: 'id_card',
        id_country_code: 'IDN',
      })
    })
  })

  it('replaces the form with the provider page once the anchor has opened one, so nobody submits the same details twice', async () => {
    let asked = 0
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') {
        asked += 1
        return asked === 1
          ? { status: 'NEEDS_INFO', fields: FIELDS }
          : { id: 'GDCP', status: 'PROCESSING', message: OPEN_AT_PROVIDER }
      }
      return { id: 'GDCP' }
    })
    mount()
    await screen.findByTestId('identity-form')
    for (const name of Object.keys(FIELDS)) {
      fireEvent.change(document.querySelector(`input[name="${name}"]`)!, { target: { value: 'x' } })
    }
    fireEvent.submit(screen.getByTestId('identity-form'))

    await waitFor(() => {
      expect(screen.queryByTestId('identity-form')).toBeNull()
    })
    expect(
      screen.getByTestId('identity-card').querySelector('a')?.getAttribute('href'),
    ).toBe('https://verify.didit.me/s/abc123')
  })

  it('will not let a half-filled submission leave the browser, because the anchor records it as incomplete rather than refusing it', async () => {
    answering({ status: 'NEEDS_INFO', fields: FIELDS })
    mount()
    await screen.findByTestId('identity-form')
    for (const name of Object.keys(FIELDS)) {
      expect(document.querySelector(`input[name="${name}"]`)!.hasAttribute('required')).toBe(true)
    }
    expect(document.querySelector('input[name="email_address"]')!.getAttribute('type')).toBe('email')
  })

  it('opens the anchor’s own sentence, with the provider page reachable from it', async () => {
    answering({ id: 'GDCP', status: 'PROCESSING', message: OPEN_AT_PROVIDER })
    mount()
    const card = await screen.findByTestId('identity-card')
    expect(card.textContent).toContain('this verification is open at the provider')
    expect(card.textContent).toContain('if it has expired, submit your details again after a day')

    const link = card.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://verify.didit.me/s/abc123')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.queryByTestId('identity-form')).toBeNull()
  })

  it('shows a waiting customer the anchor’s words and promises no conclusion of its own', async () => {
    answering({ id: 'GDCP', status: 'PROCESSING', message: AWAITING_SCREENING })
    mount()
    const card = await screen.findByTestId('identity-card')
    expect(card.textContent).toContain(AWAITING_SCREENING)
    expect(card.querySelector('a')).toBeNull()
    expect(card.textContent).not.toMatch(/soon|shortly|will be|any moment/i)
    expect(screen.queryByTestId('identity-form')).toBeNull()
  })

  it('says verified only for the status the anchor lets through its own money gate', async () => {
    answering({ id: 'GDCP', status: 'ACCEPTED', provided_fields: FIELDS })
    mount()
    const card = await screen.findByTestId('identity-card')
    expect(card.textContent).toContain('Verified')
    expect(screen.queryByTestId('identity-form')).toBeNull()
  })

  it('repeats a refusal in the anchor’s words and offers no way to resubmit, because the anchor will not take one', async () => {
    answering({ id: 'GDCP', status: 'REJECTED', message: 'this identity was refused' })
    mount()
    const card = await screen.findByTestId('identity-card')
    expect(card.textContent).toContain('this identity was refused')
    expect(screen.queryByTestId('identity-form')).toBeNull()
  })

  it('shows the anchor’s refusal when the submission is turned down, rather than a success this app invented', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'GET') return { status: 'NEEDS_INFO', fields: FIELDS }
      throw new Error('this anchor has already opened 40 verifications in the last day, which is its whole budget')
    })
    mount()
    await screen.findByTestId('identity-form')
    for (const name of Object.keys(FIELDS)) {
      fireEvent.change(document.querySelector(`input[name="${name}"]`)!, { target: { value: 'x' } })
    }
    fireEvent.submit(screen.getByTestId('identity-form'))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'this anchor has already opened 40 verifications in the last day, which is its whole budget',
    )
  })

  it('renders nothing at all when the anchor cannot be reached, so no status is fabricated', async () => {
    mockRequest.mockRejectedValue(new Error('network down'))
    mount()
    await waitFor(() => {
      expect(screen.queryByTestId('identity-card')).toBeNull()
    })
  })
})

describe('the provider page is pulled out of the sentence the anchor wrote', () => {
  it('finds the link and leaves the punctuation around it alone', () => {
    expect(splitProviderLink(OPEN_AT_PROVIDER)).toEqual([
      'this verification is open at the provider — complete it at ',
      'https://verify.didit.me/s/abc123',
      '; if it has expired, submit your details again after a day and a new one will be opened',
    ])
  })

  it('returns no link from a sentence that carries none', () => {
    expect(splitProviderLink(AWAITING_SCREENING)).toEqual([AWAITING_SCREENING, null, ''])
  })

  it('never turns a plain-http address into a link, because the anchor only ever writes https', () => {
    expect(splitProviderLink('open it at http://verify.didit.me/s/abc')).toEqual([
      'open it at http://verify.didit.me/s/abc',
      null,
      '',
    ])
  })
})
