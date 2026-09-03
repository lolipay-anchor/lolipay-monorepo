import * as React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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
    getLpEligibility: vi.fn().mockResolvedValue({
      staked: '0',
      unbonding: '0',
      unbond_available_at: 0,
      min_stake: '5000000000',
      eligible: false,
    }),
    getNotifications: vi.fn().mockResolvedValue({ items: [], unread: 0 }),
  }
})

const DashboardPage = (await import('@/app/page')).default
const apiClient = await import('@lolipay/api-client')

function makeLpMe(online = false) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
  }
}

describe('DashboardPage — Availability', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.mocked(apiClient.setAvailability).mockResolvedValue({ ok: true })
    vi.mocked(apiClient.heartbeat).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the availability toggle after me loads', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('availability-toggle')).toBeTruthy()
    })
  })

  it('toggle starts in offline state (aria-pressed=false) when me.online=false', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    const toggle = screen.getByTestId('availability-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('toggle starts in online state (aria-pressed=true) when me.online=true', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    const toggle = screen.getByTestId('availability-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('calls setAvailability(true) when toggling from offline to online', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(apiClient.setAvailability).toHaveBeenCalledWith(
        expect.anything(),
        true,
      )
    })
  })

  it('calls setAvailability(false) when toggling from online to offline', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(apiClient.setAvailability).toHaveBeenCalledWith(
        expect.anything(),
        false,
      )
    })
  })

  it('shows "Online — accepting orders" text after toggling on', async () => {
    vi.mocked(apiClient.setAvailability).mockImplementation(async (_client, next) => {
      vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(next))
      return { ok: true }
    })
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByText(/Offline/i)).toBeTruthy()

    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(screen.getByText(/Online — accepting orders/i)).toBeTruthy()
    })
  })

  it('shows the eligibility link', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      const link = screen.getByRole('link', { name: /View stake/i })
      expect(link).toBeTruthy()
      expect(link.getAttribute('href')).toBe('/stake')
    })
  })
})
