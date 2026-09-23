import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
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
    authenticate: vi.fn(),
    getLpMe: vi.fn(),
    setAvailability: vi.fn(),
    heartbeat: vi.fn(),

    getAssignments: vi.fn().mockResolvedValue([]),
    getLpEarnings: vi.fn().mockResolvedValue({ today_trades: 0, today_earned_usdc: 0, today_volume_usdc: 0, week_bars: [], all_time_trades: 0, all_time_earned_usdc: 0 }),
    getLpEligibility: vi.fn(),
    getNotifications: vi.fn().mockResolvedValue({ items: [], unread: 0 }),
  }
})

const DashboardPage = (await import('@/app/page')).default
const apiClient = await import('@lolipay/api-client')

function makeLpMe(reachable: boolean) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online: false,
    matchable: false,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
    reachable,
  }
}

const noStake = {
  staked: '0',
  unbonding: '0',
  unbond_available_at: 0,
  min_stake: '5000000000',
  eligible: false,
}

describe('DashboardPage — order alert email (ADR 0054)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(noStake)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows Off and the no-address copy when the provider cannot be reached', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    expect(await screen.findByTestId('alert-email-card')).toBeTruthy()
    expect(screen.getByText('Off')).toBeTruthy()
    expect(screen.getByText(/No email address on file/)).toBeTruthy()
  })

  it('shows On and never echoes an address back when the provider is reachable', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    expect(await screen.findByText('On')).toBeTruthy()
    expect(screen.getByText(/Alerts can reach you/)).toBeTruthy()
    expect(screen.queryByText(/test@example\.com/)).toBeNull()
  })

  it('saves a new address and shows the success sentence', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/lp/me') && init?.method === 'PATCH') {
          return { ok: true, status: 200, json: async () => ({ ok: true }) }
        }
        return { ok: false, status: 404, json: async () => ({ message: 'not mocked' }) }
      }),
    )
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByTestId('alert-email-card')
    fireEvent.change(screen.getByTestId('alert-email-input'), { target: { value: 'ops@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByTestId('alert-email-success')).toHaveTextContent(
      'Saved. Order alerts now go to that address.',
    )
  })

  it('shows the server refusal verbatim when it returns one', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ message: 'alertEmail must be an email' }),
      })),
    )
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByTestId('alert-email-card')
    fireEvent.change(screen.getByTestId('alert-email-input'), { target: { value: 'ops@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByTestId('alert-email-error')).toHaveTextContent('alertEmail must be an email')
  })

  it('falls back to a plain sentence on an empty refusal body', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('invalid json')
        },
      })),
    )
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByTestId('alert-email-card')
    fireEvent.change(screen.getByTestId('alert-email-input'), { target: { value: 'ops@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByTestId('alert-email-error')).toHaveTextContent(
      'Could not save that address. Check it and try again.',
    )
  })

  it('falls back to a plain sentence on a transport error', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch')
      }),
    )
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByTestId('alert-email-card')
    fireEvent.change(screen.getByTestId('alert-email-input'), { target: { value: 'ops@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.getByTestId('alert-email-error')).toHaveTextContent(
        'Could not save that address. Check it and try again.',
      )
    })
  })
})
