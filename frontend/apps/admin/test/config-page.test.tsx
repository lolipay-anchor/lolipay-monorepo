import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/config'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async () => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),
    getAdminConfig: vi.fn(),
    patchAdminConfig: vi.fn(),
    getLps: vi.fn(),
  }
})

const ConfigPage = (await import('@/app/config/page')).default
const apiClient = await import('@lolipay/api-client')
const { queryClient } = await import('@/app/providers')

const MOCK_CONFIG = {
  id: 1,
  spreadBps: 50,
  platformFeeBps: 30,
  lpFeeBps: 20,
  platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  minOrder: '10000000',
  maxOrder: '1000000000',
  payWindowSecs: 1800,
  confirmWindowSecs: 900,
  disputeWindowSecs: 86400,
  paused: false,
  updatedAt: '2024-01-15T10:00:00.000Z',
  requireProof: false,
  autoRefund: false,
  postSettleDisputeWindowSecs: 3600,
}

describe('Config page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    queryClient.clear()
  })

  it('renders the config form with values from getAdminConfig', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      const spreadInput = screen.getByDisplayValue('50') as HTMLInputElement
      expect(spreadInput).toBeTruthy()
    })

    expect(screen.getByDisplayValue('30')).toBeTruthy()
    expect(screen.getByDisplayValue('20')).toBeTruthy()
  })

  it('disables save and shows error when platformFeeBps + lpFeeBps >= 10000', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      platformFeeBps: 5000,
      lpFeeBps: 4999,
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('5000')).toBeTruthy()
    })

    const lpFeeInput = screen.getByDisplayValue('4999') as HTMLInputElement
    fireEvent.change(lpFeeInput, { target: { value: '5000' } })

    await waitFor(() => {
      expect(screen.getByTestId('fee-invariant-error')).toBeTruthy()
    })

    const saveBtn = screen.getByTestId('save-config') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
  })

  it('enforces fee invariant: sum exactly 9999 keeps save enabled', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      platformFeeBps: 5000,
      lpFeeBps: 4998,
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('4998')).toBeTruthy()
    })

    const lpFeeInput = screen.getByDisplayValue('4998') as HTMLInputElement
    fireEvent.change(lpFeeInput, { target: { value: '4999' } })

    await waitFor(() => {
      expect(screen.queryByTestId('fee-invariant-error')).toBeNull()
    })

    const saveBtn = screen.getByTestId('save-config') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
  })

  it('calls patchAdminConfig with only the changed fields on save', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)
    vi.mocked(apiClient.patchAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      spreadBps: 75,
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('50')).toBeTruthy()
    })

    const spreadInput = screen.getByDisplayValue('50') as HTMLInputElement
    fireEvent.change(spreadInput, { target: { value: '75' } })

    await waitFor(() => {
      const saveBtn = screen.getByTestId('save-config') as HTMLButtonElement
      expect(saveBtn.disabled).toBe(false)
    })

    fireEvent.click(screen.getByTestId('save-config'))

    await waitFor(() => {
      expect(apiClient.patchAdminConfig).toHaveBeenCalledOnce()
    })

    const patchArg = vi.mocked(apiClient.patchAdminConfig).mock.calls[0][1]
    expect(patchArg).toEqual({ spreadBps: 75 })

    expect((patchArg as Record<string, unknown>).platformFeeBps).toBeUndefined()
  })

  it('shows minOrder/maxOrder/windows as editable fields pre-filled from getAdminConfig', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('10000000')).toBeTruthy()
    })
    expect(screen.getByDisplayValue('1000000000')).toBeTruthy()

    expect(screen.getAllByDisplayValue('1800').length).toBe(1)
    expect(screen.getAllByDisplayValue('900').length).toBe(1)
    expect(screen.getByDisplayValue('86400')).toBeTruthy()
  })

  it('only Last updated remains read-only', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Read-only')).toBeTruthy()
    })
    expect(screen.getByText('Last updated')).toBeTruthy()
  })

  it('shows the per-market rate override note instead of a global override field', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('rate-override-note')).toBeTruthy()
    })
    expect(screen.getByTestId('rate-override-note')).toHaveTextContent(
      'Rate override is per-market now',
    )
    expect(screen.queryByText(/manual rate override/i)).toBeNull()
  })

  it('renders the anti-fraud toggles pre-filled from getAdminConfig', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      requireProof: true,
      autoRefund: false,
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('require-proof-toggle')).toBeTruthy()
    })
    expect((screen.getByTestId('require-proof-toggle') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('auto-refund-toggle') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByDisplayValue('3600')).toBeTruthy()
  })

  it('toggling requireProof marks the form dirty and includes it in the patch', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)
    vi.mocked(apiClient.patchAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      requireProof: true,
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('require-proof-toggle'))
    fireEvent.click(screen.getByTestId('require-proof-toggle'))

    const saveBtn = screen.getByTestId('save-config') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(apiClient.patchAdminConfig).toHaveBeenCalledOnce()
    })
    const patchArg = vi.mocked(apiClient.patchAdminConfig).mock.calls[0][1]
    expect(patchArg).toEqual({ requireProof: true })
  })

  it.each(['300', '600', '1199'])('rejects a payWindowSecs of %s, under the usable floor the coordinator enforces, and disables save', async (value) => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getAllByDisplayValue('1800'))
    const payWindowInput = screen.getAllByDisplayValue('1800')[0] as HTMLInputElement
    fireEvent.change(payWindowInput, { target: { value } })

    await waitFor(() => {
      expect(screen.getByText(/payWindowSecs must be at least 1200 seconds/i)).toBeTruthy()
    })
    expect((screen.getByTestId('save-config') as HTMLButtonElement).disabled).toBe(true)
  })

  it('names the reason for the floor in the hint: the contract refuses a signature inside the last ten minutes', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getAllByDisplayValue('1800'))
    expect(screen.getByText(/last 600 seconds/i)).toBeTruthy()
    expect(screen.queryByText(/rejects anything shorter/i)).toBeNull()
  })

  it('rejects a non-numeric minOrder string and disables save', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByDisplayValue('10000000'))
    fireEvent.change(screen.getByDisplayValue('10000000'), { target: { value: 'not-a-number' } })

    await waitFor(() => {
      expect(screen.getByText(/minOrder must be a positive integer/i)).toBeTruthy()
    })
    expect((screen.getByTestId('save-config') as HTMLButtonElement).disabled).toBe(true)
  })

  it('editing maxOrder saves the new string value via patchAdminConfig', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)
    vi.mocked(apiClient.patchAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      maxOrder: '2000000000',
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByDisplayValue('1000000000'))
    fireEvent.change(screen.getByDisplayValue('1000000000'), { target: { value: '2000000000' } })

    const saveBtn = screen.getByTestId('save-config') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(apiClient.patchAdminConfig).toHaveBeenCalledOnce()
    })
    const patchArg = vi.mocked(apiClient.patchAdminConfig).mock.calls[0][1]
    expect(patchArg).toEqual({ maxOrder: '2000000000' })
  })

  it('shows loading state', () => {
    vi.mocked(apiClient.getAdminConfig).mockReturnValueOnce(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    expect(screen.getByText('Loading…')).toBeTruthy()
  })
  it('shows the four built-in defaults, and says they are defaults, when the config has never stored them', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect((screen.getByTestId('daily-limit-BRONZE') as HTMLInputElement).value).toBe('100')
    expect((screen.getByTestId('daily-limit-SILVER') as HTMLInputElement).value).toBe('300')
    expect((screen.getByTestId('daily-limit-TRUSTED') as HTMLInputElement).value).toBe('600')
    expect((screen.getByTestId('daily-limit-GOLD') as HTMLInputElement).value).toBe('2000')
    expect(screen.getByTestId('daily-limit-defaults-note')).toHaveTextContent(
      'No daily limit has been stored, so these built-in defaults are what is in force right now. Saving writes all four as stored values, and a later change to the built-in defaults will not reach them.',
    )
  })

  it('names the tiers still on defaults when the stored object covers only some of them', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      dailyLimitByTier: { BRONZE: 111 },
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-defaults-note'))
    expect(screen.getByTestId('daily-limit-defaults-note')).toHaveTextContent(
      'No limit is stored for Silver, Trusted, Gold, so their built-in defaults are what is in force right now.',
    )
  })

  it('describes the allowance as person-scoped without promising that every wallet is counted', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect(document.body.textContent).not.toMatch(/does not give them a second allowance/)
    expect(document.body.textContent).toContain(
      'counted across every wallet they have linked to their account',
    )
    expect(document.body.textContent).toContain(
      'a wallet they never link is a separate account with its own allowance',
    )
  })

  it('labels the tiers by name only, and states the dispute rule the coordinator actually applies', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect(document.body.textContent).not.toMatch(/Gold — 50 or more/)
    expect(document.body.textContent).not.toMatch(/under 5 completed trades/)
    expect(document.body.textContent).toContain(
      'Tier comes from completed trades — 5 for Silver, 20 for Trusted, 50 for Gold — and each lost dispute drops a person one tier.',
    )
  })

  it('shows the stored values and drops the defaults note once the config carries them', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      dailyLimitByTier: { BRONZE: 111, SILVER: 333, TRUSTED: 666, GOLD: 2222 },
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect((screen.getByTestId('daily-limit-BRONZE') as HTMLInputElement).value).toBe('111')
    expect((screen.getByTestId('daily-limit-GOLD') as HTMLInputElement).value).toBe('2222')
    expect(screen.queryByTestId('daily-limit-defaults-note')).toBeNull()
  })

  it('fills a tier the stored object left out from its built-in default, the same way the coordinator does', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      ...MOCK_CONFIG,
      dailyLimitByTier: { BRONZE: 111 },
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect((screen.getByTestId('daily-limit-BRONZE') as HTMLInputElement).value).toBe('111')
    expect((screen.getByTestId('daily-limit-SILVER') as HTMLInputElement).value).toBe('300')
    expect((screen.getByTestId('daily-limit-TRUSTED') as HTMLInputElement).value).toBe('600')
    expect((screen.getByTestId('daily-limit-GOLD') as HTMLInputElement).value).toBe('2000')
  })

  it('sends all four tiers when only one was changed, because the server replaces the whole set', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)
    vi.mocked(apiClient.patchAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-GOLD'))
    fireEvent.change(screen.getByTestId('daily-limit-GOLD'), { target: { value: '2500' } })

    fireEvent.click(screen.getByTestId('save-config'))
    fireEvent.click(await screen.findByRole('button', { name: 'Set the limit' }))

    await waitFor(() => {
      expect(apiClient.patchAdminConfig).toHaveBeenCalledOnce()
    })
    expect(vi.mocked(apiClient.patchAdminConfig).mock.calls[0][1]).toEqual({
      dailyLimitByTier: { BRONZE: 100, SILVER: 300, TRUSTED: 600, GOLD: 2500 },
    })
  })

  it('sends nothing at all when the confirmation is cancelled', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    fireEvent.change(screen.getByTestId('daily-limit-BRONZE'), { target: { value: '150' } })

    fireEvent.click(screen.getByTestId('save-config'))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByTestId('daily-limit-confirm')).toBeNull()
    })
    expect(apiClient.patchAdminConfig).not.toHaveBeenCalled()
  })

  it('spells out both the old and the new set of four in the confirmation, per person per 24 hours', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-GOLD'))
    fireEvent.change(screen.getByTestId('daily-limit-GOLD'), { target: { value: '2500' } })
    fireEvent.click(screen.getByTestId('save-config'))

    const dialog = await screen.findByTestId('daily-limit-confirm')
    expect(dialog).toHaveTextContent('Set the daily limit for everyone?')
    expect(dialog).toHaveTextContent(
      'From the built-in defaults — Bronze 100 · Silver 300 · Trusted 600 · Gold 2000, which is what is in force now.',
    )
    expect(dialog).toHaveTextContent(
      'to Bronze 100 · Silver 300 · Trusted 600 · Gold 2500, in USDC per 24 hours per person.',
    )
    expect(dialog).toHaveTextContent(
      'Saving stores these four numbers for every depositor. They apply to the next quote or order anyone requests. Orders already open are not affected, and a quote already issued is re-checked when it becomes an order.',
    )
    expect(dialog).toHaveTextContent('Set the limit')
    expect(dialog).not.toHaveTextContent(/immediately/i)
  })

  it('says CHANGE rather than SET, and names the stored limits, once a limit is already stored', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue({
      ...MOCK_CONFIG,
      dailyLimitByTier: { BRONZE: 111, SILVER: 333, TRUSTED: 666, GOLD: 2222 },
    })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-GOLD'))
    fireEvent.change(screen.getByTestId('daily-limit-GOLD'), { target: { value: '2500' } })
    fireEvent.click(screen.getByTestId('save-config'))

    const dialog = await screen.findByTestId('daily-limit-confirm')
    expect(dialog).toHaveTextContent('Change the daily limit for everyone?')
    expect(dialog).toHaveTextContent(
      'From the stored limits — Bronze 111 · Silver 333 · Trusted 666 · Gold 2222.',
    )
    expect(dialog).toHaveTextContent('Change the limit')
    expect(dialog).not.toHaveTextContent('built-in defaults')
  })

  it('asks for no confirmation when the daily limits were not touched', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)
    vi.mocked(apiClient.patchAdminConfig).mockResolvedValueOnce({ ...MOCK_CONFIG, spreadBps: 75 })

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByDisplayValue('50'))
    fireEvent.change(screen.getByDisplayValue('50'), { target: { value: '75' } })
    fireEvent.click(screen.getByTestId('save-config'))

    await waitFor(() => {
      expect(apiClient.patchAdminConfig).toHaveBeenCalledOnce()
    })
    expect(screen.queryByTestId('daily-limit-confirm')).toBeNull()
    expect(vi.mocked(apiClient.patchAdminConfig).mock.calls[0][1]).toEqual({ spreadBps: 75 })
  })

  it('refuses a tier below 1 and disables save, because the server has no way to express no allowance', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-SILVER'))
    fireEvent.change(screen.getByTestId('daily-limit-SILVER'), { target: { value: '0' } })

    await waitFor(() => {
      expect(
        screen.getByText(
          'Every tier needs a whole number of 1 or more. You cannot save until all four have one.',
        ),
      ).toBeTruthy()
    })
    expect((screen.getByTestId('save-config') as HTMLButtonElement).disabled).toBe(true)
  })

  it('refuses a tier above the largest integer JavaScript can hold exactly', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-GOLD'))
    fireEvent.change(screen.getByTestId('daily-limit-GOLD'), { target: { value: '1e21' } })

    await waitFor(() => {
      expect(screen.getByTestId('daily-limit-error')).toBeTruthy()
    })
    expect((screen.getByTestId('save-config') as HTMLButtonElement).disabled).toBe(true)
  })

  it('warns but still allows saving when Bronze is at or above Silver', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    fireEvent.change(screen.getByTestId('daily-limit-BRONZE'), { target: { value: '300' } })

    await waitFor(() => {
      expect(screen.getByTestId('daily-limit-ladder-warning')).toHaveTextContent(
        'Bronze is at or above Silver. A depositor on Bronze would be allowed at least as much per day as one on Silver, which is the higher tier. Save anyway only if that is what you intend.',
      )
    })
    expect((screen.getByTestId('save-config') as HTMLButtonElement).disabled).toBe(false)
  })

  it('warns about an inverted pair that is not Bronze over Silver, so the silence means the whole ladder', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-SILVER'))
    fireEvent.change(screen.getByTestId('daily-limit-SILVER'), { target: { value: '5000' } })

    await waitFor(() => {
      expect(screen.getByTestId('daily-limit-ladder-warning')).toHaveTextContent(
        'Silver is at or above Trusted. A depositor on Silver would be allowed at least as much per day as one on Trusted, which is the higher tier. Save anyway only if that is what you intend.',
      )
    })
  })

  it('warns about the Trusted over Gold pair, the one no adjacent-pair shortcut reaches', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-TRUSTED'))
    fireEvent.change(screen.getByTestId('daily-limit-TRUSTED'), { target: { value: '2000' } })

    await waitFor(() => {
      expect(screen.getByTestId('daily-limit-ladder-warning')).toHaveTextContent(
        'Trusted is at or above Gold.',
      )
    })
  })

  it('stays silent while the four rise in order, so the warning means something when it appears', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect(screen.queryByTestId('daily-limit-ladder-warning')).toBeNull()
  })

  it('closes a confirmation the refreshed config has emptied, rather than sending an empty patch', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValue(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-GOLD'))
    fireEvent.change(screen.getByTestId('daily-limit-GOLD'), { target: { value: '2500' } })
    fireEvent.click(screen.getByTestId('save-config'))
    await screen.findByTestId('daily-limit-confirm')

    vi.mocked(apiClient.getAdminConfig).mockResolvedValue({
      ...MOCK_CONFIG,
      updatedAt: '2024-01-15T11:00:00.000Z',
    })
    queryClient.refetchQueries({ queryKey: ['adminConfig'] })

    await waitFor(() => {
      expect(screen.queryByTestId('daily-limit-confirm')).toBeNull()
    })
    expect(apiClient.patchAdminConfig).not.toHaveBeenCalled()
  })

  it('names the live max order in the ceiling note rather than a hardcoded one', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-other-ceilings'))
    expect(screen.getByTestId('daily-limit-other-ceilings')).toHaveTextContent(
      '(100.00 USDC as currently entered)',
    )

    fireEvent.change(screen.getByDisplayValue('1000000000'), { target: { value: '5000000000' } })
    await waitFor(() => {
      expect(screen.getByTestId('daily-limit-other-ceilings')).toHaveTextContent(
        '(500.00 USDC as currently entered)',
      )
    })
  })

  it('calls the daily limit the tightest ceiling rather than merely one of several', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-other-ceilings'))
    expect(screen.getByTestId('daily-limit-other-ceilings')).toHaveTextContent(
      'This is not the only ceiling — but it is usually the tightest.',
    )
    expect(screen.getByTestId('daily-limit-other-ceilings')).toHaveTextContent(
      'a provider can never hold more live orders at once than their own stake covers',
    )
    expect(screen.getByTestId('daily-limit-other-ceilings')).toHaveTextContent(
      'Any tier set below the Max order figure is the ceiling a person actually meets first.',
    )
  })

  it('never offers the word unlimited, because the coordinator has no such state', async () => {
    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce(MOCK_CONFIG)

    render(
      <TestProviders kit={fakeKit}>
        <ConfigPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('daily-limit-BRONZE'))
    expect(document.body.textContent).not.toMatch(/unlimited/i)
  })
})
