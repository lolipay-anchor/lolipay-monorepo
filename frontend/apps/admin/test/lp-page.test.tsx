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
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async () => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),
    getLps: vi.fn(),
    setLpStatus: vi.fn(),
    registerLp: vi.fn(),
    getAdminConfig: vi.fn(),
  }
})

const LPsPage = (await import('@/app/page')).default
const apiClient = await import('@lolipay/api-client')
const { queryClient } = await import('@/app/providers')

const MOCK_LP = {
  id: 'lp-1',
  stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6XAAAAAAA',
  status: 'PENDING' as const,
  contact: 'lp@example.com',
  liquidityProof: 'https://proof.example.com',
  approvalNote: null,
  online: false,
  lastHeartbeatAt: null,
  createdAt: '2024-01-15T10:00:00.000Z',
  approvedAt: null,
}

describe('LPs page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    queryClient.clear()
  })

  it('registers an LP via the admin form', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValue([])
    vi.mocked(apiClient.registerLp).mockResolvedValueOnce({ ...MOCK_LP, status: 'APPROVED' })
    const ADDR = 'G' + 'A'.repeat(55)

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    fireEvent.click(await screen.findByTestId('open-register'))

    fireEvent.change(screen.getByTestId('reg-address'), { target: { value: ADDR } })
    fireEvent.change(screen.getByTestId('reg-contact'), { target: { value: 'tg:@lp_budi' } })
    fireEvent.click(screen.getByTestId('reg-submit'))

    await waitFor(() =>
      expect(apiClient.registerLp).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ stellarAddress: ADDR, contact: 'tg:@lp_budi', approve: true }),
      ),
    )
  })

  it('keeps the register submit disabled for an invalid address', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValue([])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    fireEvent.click(await screen.findByTestId('open-register'))
    fireEvent.change(screen.getByTestId('reg-address'), { target: { value: 'not-an-address' } })
    fireEvent.change(screen.getByTestId('reg-contact'), { target: { value: 'x' } })
    expect((screen.getByTestId('reg-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders an LP card from getLps', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValueOnce([MOCK_LP])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/GDCPLK/)).toBeTruthy()
    })

    expect(screen.getByText('lp@example.com')).toBeTruthy()

    const allPending = screen.getAllByText('PENDING')
    expect(allPending.length).toBeGreaterThanOrEqual(1)

    const badge = allPending.find((el) => el.className.includes('rounded-lp-pill'))
    expect(badge).toBeTruthy()
    expect(screen.getByText('Approve')).toBeTruthy()
  })

  it('clicking Approve shows the note form', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValueOnce([MOCK_LP])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Optional note/i)).toBeTruthy()
      expect(screen.getByTestId('confirm-action')).toBeTruthy()
    })
  })

  it('clicking Confirm Approve calls setLpStatus with correct args', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValue([MOCK_LP])
    vi.mocked(apiClient.setLpStatus).mockResolvedValueOnce({
      ...MOCK_LP,
      status: 'APPROVED' as const,
      approvalNote: 'looks good',
      approvedAt: new Date().toISOString(),
    })

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('Approve'))

    await waitFor(() => {
      expect(screen.getByTestId('confirm-action')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('confirm-action'))

    await waitFor(() => {
      expect(apiClient.setLpStatus).toHaveBeenCalledOnce()
    })

    const callArgs = vi.mocked(apiClient.setLpStatus).mock.calls[0]

    expect(callArgs[1]).toBe('lp-1')
    expect(callArgs[2]).toBe('approve')
  })

  it('obeys its own 409: a decision refused because the provider moved collapses the card and reloads the list before the administrator can click again', async () => {
    const { ApiError } = await import('@lolipay/api-client')
    vi.mocked(apiClient.getLps).mockResolvedValue([MOCK_LP])
    vi.mocked(apiClient.setLpStatus).mockRejectedValueOnce(
      new ApiError(409, "the provider's status changed while you were deciding — reload and decide again"),
    )

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy()
    })
    fireEvent.click(await screen.findByRole('button', { name: 'PENDING' }))
    await waitFor(() => {
      expect(vi.mocked(apiClient.getLps)).toHaveBeenCalledWith(expect.anything(), 'PENDING')
    })
    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy()
    })
    const listReadsBefore = vi.mocked(apiClient.getLps).mock.calls.length

    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => {
      expect(screen.getByTestId('confirm-action')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('confirm-action'))

    await waitFor(() => {
      expect(screen.getByText("the provider's status changed while you were deciding — reload and decide again")).toBeTruthy()
    })
    expect(screen.queryByTestId('confirm-action')).toBeNull()
    await waitFor(() => {
      const after = vi.mocked(apiClient.getLps).mock.calls.slice(listReadsBefore).map((c) => c[1])
      expect(after).toContain('PENDING')
      expect(after).toContain(undefined)
    })
  })

  it('leaves the card open on any other refusal, so a 500 does not throw away what the administrator typed', async () => {
    const { ApiError } = await import('@lolipay/api-client')
    vi.mocked(apiClient.getLps).mockResolvedValue([MOCK_LP])
    vi.mocked(apiClient.setLpStatus).mockReset()
    vi.mocked(apiClient.setLpStatus).mockRejectedValueOnce(new ApiError(500, 'server exploded'))

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Approve')).toBeTruthy()
    })
    const listReadsBefore = vi.mocked(apiClient.getLps).mock.calls.length
    fireEvent.click(screen.getByText('Approve'))
    await waitFor(() => {
      expect(screen.getByTestId('confirm-action')).toBeTruthy()
    })
    fireEvent.change(screen.getByLabelText('Action note'), { target: { value: 'typed before the failure' } })
    fireEvent.click(screen.getByTestId('confirm-action'))

    await waitFor(() => {
      expect(screen.getByText('server exploded')).toBeTruthy()
    })
    expect(screen.getByTestId('confirm-action')).toBeTruthy()
    expect((screen.getByLabelText('Action note') as HTMLTextAreaElement).value).toBe('typed before the failure')
    expect(vi.mocked(apiClient.getLps).mock.calls.length).toBe(listReadsBefore)
  })

  it('shows the online dot when LP is online', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValueOnce([
      { ...MOCK_LP, online: true },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      const onlineDot = screen.getByLabelText('online')
      expect(onlineDot).toBeTruthy()
    })
  })

  it('shows approvalNote when present', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValueOnce([
      { ...MOCK_LP, approvalNote: 'great liquidity', status: 'APPROVED' as const },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/great liquidity/)).toBeTruthy()
    })
  })

  it('shows empty state when no LPs', async () => {
    vi.mocked(apiClient.getLps).mockResolvedValueOnce([])

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('No LPs found.')).toBeTruthy()
    })
  })

  it('summary strip shows the true global counts (not the filtered list) when a non-ALL filter chip is active', async () => {
    const ALL_LPS = [
      { ...MOCK_LP, id: 'lp-1', status: 'APPROVED' as const, online: true },
      { ...MOCK_LP, id: 'lp-2', status: 'APPROVED' as const, online: false },
      { ...MOCK_LP, id: 'lp-3', status: 'PENDING' as const, online: true },
      { ...MOCK_LP, id: 'lp-4', status: 'SUSPENDED' as const, online: false },
    ]

    const SUSPENDED_LPS = [{ ...MOCK_LP, id: 'lp-4', status: 'SUSPENDED' as const, online: false }]

    vi.mocked(apiClient.getLps).mockImplementation((_client, status) => {
      if (status === 'SUSPENDED') return Promise.resolve(SUSPENDED_LPS)
      if (status === undefined) return Promise.resolve(ALL_LPS)
      return Promise.resolve([])
    })

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    fireEvent.click(await screen.findByText('SUSPENDED'))

    await waitFor(() => {
      expect(screen.getAllByText('SUSPENDED').length).toBeGreaterThanOrEqual(1)
    })

    await waitFor(() => {
      const approvedCard = screen.getByText('Approved').parentElement
      expect(approvedCard).toHaveTextContent('2')
    })
    const pendingCard = screen.getByText('Pending').parentElement
    expect(pendingCard).toHaveTextContent('1')
    const onlineCard = screen.getByText('Online now').parentElement
    expect(onlineCard).toHaveTextContent('2')
  })

  it('shows loading state', async () => {
    vi.mocked(apiClient.getLps).mockReturnValueOnce(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <LPsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Loading…')).toBeTruthy()
    })
  })
})
