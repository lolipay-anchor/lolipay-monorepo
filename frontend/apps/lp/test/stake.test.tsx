import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>()
  return {
    ...actual,
    rpc: { ...actual.rpc, Server: vi.fn() },
    TransactionBuilder: { ...actual.TransactionBuilder, fromXDR: vi.fn() },
  }
})

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
  usePathname: vi.fn(() => '/stake'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(),
    getLpEligibility: vi.fn(),
    getStakeTx: vi.fn(),
    getRequestUnstakeTx: vi.fn(),
    getClaimUnstakeTx: vi.fn(),
  }
})

const { StakeForm } = await import('@/app/stake/page')
const apiClient = await import('@lolipay/api-client')
const sdk = await import('@stellar/stellar-sdk')

function createDeferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const mockEligibility = {
  staked: '1000000000',
  min_stake: '5000000000',
  eligible: false,
  unbonding: '0',
  unbond_available_at: 0,
}

describe('StakePage — StakeForm', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(mockEligibility)
  })

  it('shows a loading state before eligibility resolves', () => {
    vi.mocked(apiClient.getLpEligibility).mockReturnValue(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    expect(screen.getByText(/loading eligibility/i)).toBeTruthy()
  })

  it('says what the stake is for, and that a lost post-settlement dispute can draw on it, unbonding included', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )
    await waitFor(() => {
      expect(
        screen.getByText(/Your staked USDC is the bond behind your trades\. If a dispute raised after a trade has settled is resolved against you, what you owe can be taken from your stake — including USDC that is unbonding but not yet claimed\./),
      ).toBeTruthy()
    })
  })

  it('shows staked and min_stake values with correct USDC formatting', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/100\.00/).length).toBeGreaterThan(0)

      expect(screen.getAllByText(/500\.00/).length).toBeGreaterThan(0)
    })
  })

  it('shows Not eligible badge when eligible=false', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Not eligible/i)).toBeTruthy()
    })
  })

  it('shows Eligible badge when eligible=true', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      staked: '5000000000',
      eligible: true,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/^Eligible$/)).toBeTruthy()
    })
  })

  it('shows unbonding details, the claimable date and a relative day count, while unbonding > 0', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: 1893456000,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          /70\.00 USDC unbonding — claimable .+, about \d+ days? from now\. You are not taking orders until you claim it\./,
        ),
      ).toBeTruthy()
    })
  })

  it('renders a not-currently-matchable note while unbonding, even when eligible is true', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: true,
      unbonding: '700000000',
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.queryByText(/^Eligible$/)).toBeNull()
      expect(screen.getByText(/not taking orders/i)).toBeTruthy()
    })
  })

  it('does not refresh eligibility until the transaction reaches finality on the ledger, not just broadcast', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const deferred = createDeferred<{ status: string }>()
    const pollTransactionMock = vi.fn(() => deferred.promise)

    vi.mocked(sdk.rpc.Server).mockImplementation(function () {
      return { sendTransaction: sendTransactionMock, pollTransaction: pollTransactionMock } as never
    } as unknown as typeof sdk.rpc.Server)
    vi.mocked(sdk.TransactionBuilder.fromXDR).mockReturnValue({} as never)
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => expect(pollTransactionMock).toHaveBeenCalledWith('deadbeef'))
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(1)

    deferred.resolve({ status: 'SUCCESS' })

    await waitFor(() => expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(2))
  })

  it('renders the Unstake form', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('unstake-amount')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Request Unstake' })).toBeTruthy()
    })
  })

  it('request-unstake calls getRequestUnstakeTx with base units, signs, and submits', async () => {
    vi.mocked(apiClient.getRequestUnstakeTx).mockResolvedValue({
      xdr: 'UNSIGNED_UNSTAKE_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    const mockSubmit = vi.fn().mockResolvedValue({ status: 'PENDING' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('unstake-amount'))
    fireEvent.change(screen.getByTestId('unstake-amount'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request Unstake' }))

    await waitFor(() => {
      expect(apiClient.getRequestUnstakeTx).toHaveBeenCalledWith(
        expect.anything(),
        '300000000',
      )
      expect(mockSubmit).toHaveBeenCalledWith(
        'SIGNED_XDR',
        'Test SDF Network ; September 2015',
      )
      expect(screen.getByText(/Unstake requested/i)).toBeTruthy()
    })
  })

  it('claim button is gated by cooldown: disabled while active, enabled when reached', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) + 3600,
    })
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )
    await waitFor(() =>
      expect(
        (screen.getByTestId('claim-unstake') as HTMLButtonElement).disabled,
      ).toBe(true),
    )
    unmount()

    queryClient.clear()
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) - 10,
    })
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )
    await waitFor(() =>
      expect(
        (screen.getByTestId('claim-unstake') as HTMLButtonElement).disabled,
      ).toBe(false),
    )
  })

  it('calls getStakeTx with base units, signs, and calls submitFn with signed XDR', async () => {
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({
      xdr: 'UNSIGNED_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })

    const mockSubmit = vi.fn().mockResolvedValue({ status: 'PENDING' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))

    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => {
      expect(apiClient.getStakeTx).toHaveBeenCalledWith(
        expect.anything(),
        '1000000000',
      )

      expect(fakeKit.signTransaction).toHaveBeenCalledWith('UNSIGNED_XDR', {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })

      expect(mockSubmit).toHaveBeenCalledWith(
        'SIGNED_XDR',
        'Test SDF Network ; September 2015',
      )
    })
  })

  it('shows success message after a successful stake', async () => {
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({
      xdr: 'XDR',
      networkPassphrase: 'np',
    })
    const mockSubmit = vi.fn().mockResolvedValue({})

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => {
      expect(screen.getByText(/Stake submitted successfully/i)).toBeTruthy()
    })
  })

  it('shows an error message when wallet rejects the transaction', async () => {
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({
      xdr: 'XDR',
      networkPassphrase: 'np',
    })
    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(
      new Error('User rejected'),
    )

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText(/User rejected/i)).toBeTruthy()
    })
  })
})
