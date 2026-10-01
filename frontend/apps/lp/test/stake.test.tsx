import * as React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import { SUBMISSION_WINDOW_CLOSED } from '@lolipay/wallet'

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

const MAX_TIME = 1_790_000_150
const RETRY_AT = 1_790_000_220
const TIMED_TX = { timeBounds: { minTime: '0', maxTime: String(MAX_TIME) } }
const NOT_CONFIRMED = `This has not been confirmed yet, and it may already have gone through. Reload this page after ${new Date(RETRY_AT * 1000).toLocaleString()} and check your stake before you try again.`
const NOT_CONFIRMED_NO_TIME =
  'This has not been confirmed yet, and it may already have gone through. Reload this page and check your stake before you try again.'

function mockStakeNetwork(send: () => Promise<unknown>) {
  vi.mocked(sdk.rpc.Server).mockImplementation(function () {
    return { sendTransaction: vi.fn(send), pollTransaction: vi.fn() } as never
  } as unknown as typeof sdk.rpc.Server)
  vi.mocked(sdk.TransactionBuilder.fromXDR).mockReturnValue(TIMED_TX as never)
}

async function submitStake() {
  vi.mocked(apiClient.getStakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
  render(
    <TestProviders kit={fakeKit}>
      <StakeForm />
    </TestProviders>,
  )
  await waitFor(() => screen.getByTestId('stake-amount'))
  fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
  fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))
}

async function submitUnstake() {
  vi.mocked(apiClient.getRequestUnstakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
  render(
    <TestProviders kit={fakeKit}>
      <StakeForm />
    </TestProviders>,
  )
  await waitFor(() => screen.getByTestId('unstake-amount'))
  fireEvent.change(screen.getByTestId('unstake-amount'), { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Request Unstake' }))
}

async function submitClaim() {
  vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
    ...mockEligibility,
    unbonding: '700000000',
    unbond_available_at: Math.floor(Date.now() / 1000) - 10,
  })
  vi.mocked(apiClient.getClaimUnstakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
  render(
    <TestProviders kit={fakeKit}>
      <StakeForm />
    </TestProviders>,
  )
  await waitFor(() => screen.getByTestId('claim-unstake'))
  fireEvent.click(screen.getByTestId('claim-unstake'))
}

describe('StakePage — StakeForm', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(mockEligibility)
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('shows Not eligible badge when eligible=false, and tells them how much they need staked', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Not eligible/i)).toBeTruthy()
      expect(
        screen.getByText('You need at least 500.00 USDC staked to take orders.'),
      ).toBeTruthy()
    })
  })

  it('tells a provider what happens to a partial unstake before they sign, and warns that unstaking again resets the wait', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          'The amount leaves your stake the moment you sign — you can claim it to your wallet once the cooldown ends. Unstaking again while an amount is already unbonding resets the wait for all of it.',
        ),
      ).toBeTruthy()
    })
  })

  it('shows Eligible badge when eligible=true, and never tells an eligible provider they need to stake', async () => {
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
      expect(screen.queryByText(/You need at least/i)).toBeNull()
    })
  })

  it('shows unbonding details, the claimable date and an exact relative day count, while below the minimum stake', async () => {
    const fixedNowMs = Date.parse('2030-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNowMs)

    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: false,
      unbonding: '700000000',
      unbond_available_at: Math.floor(fixedNowMs / 1000) + 190080,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(
      screen.getByText(
        /70\.00 USDC unbonding — claimable .+, about 2 days from now\. Claiming returns it to your wallet, not to your stake\./,
      ),
    ).toBeTruthy()
  })

  it('shows the same unbonding-not-yet-claimable copy when eligible is already true, since only the amount and the clock still gate it', async () => {
    const fixedNowMs = Date.parse('2030-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNowMs)

    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: true,
      unbonding: '700000000',
      unbond_available_at: Math.floor(fixedNowMs / 1000) + 7200,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(screen.getByText(/^Eligible$/)).toBeTruthy()
    expect(
      screen.getByText(
        /70\.00 USDC unbonding — claimable .+, about 2 hours from now\. Claiming returns it to your wallet, not to your stake\./,
      ),
    ).toBeTruthy()
  })

  it('shows Eligible and the ready-to-claim card together, now that unbonding alone no longer costs a match', async () => {
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
      expect(screen.getByText(/^Eligible$/)).toBeTruthy()
      expect(screen.queryByText('Not matchable')).toBeNull()
      expect(
        screen.getByText(
          '70.00 USDC is ready to claim. Claiming returns it to your wallet — it does not go back into your stake, and nothing happens until you sign.',
        ),
      ).toBeTruthy()
    })
  })

  it('tells a provider they need to stake, unaffected by an unbonding balance that is already ready to claim', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: false,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) - 10,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(/You need at least 500\.00 USDC staked to take orders\./),
      ).toBeTruthy()
      expect(
        screen.getByText(
          /70\.00 USDC is ready to claim\. Claiming returns it to your wallet — it does not go back into your stake, and nothing happens until you sign\./,
        ),
      ).toBeTruthy()
    })
  })

  it('renders the unbonding countdown in hours, exactly, when under a day remains, and tells them what to stake regardless', async () => {
    const fixedNowMs = Date.parse('2030-01-01T00:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(fixedNowMs)

    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: false,
      unbonding: '700000000',
      unbond_available_at: Math.floor(fixedNowMs / 1000) + 7920,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(
      screen.getByText(
        /70\.00 USDC unbonding — claimable .+, about 2 hours from now\. Claiming returns it to your wallet, not to your stake\./,
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(/You need at least 500\.00 USDC staked to take orders\./),
    ).toBeTruthy()
  })

  it('when the network has not indexed the transaction yet, tells a provider it may already have gone through and to reload after its time limit and check their stake before trying again', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const pollTransactionMock = vi.fn().mockResolvedValue({ status: 'NOT_FOUND' })

    vi.mocked(sdk.rpc.Server).mockImplementation(function () {
      return { sendTransaction: sendTransactionMock, pollTransaction: pollTransactionMock } as never
    } as unknown as typeof sdk.rpc.Server)
    vi.mocked(sdk.TransactionBuilder.fromXDR).mockReturnValue(TIMED_TX as never)
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
    expect(screen.getByRole('alert')).not.toHaveClass('text-lp-danger')
    expect(screen.getByRole('alert')).toHaveClass('text-lp-ink')
  })

  it('a stake submission that got no response at all shows the not-confirmed sentence, never the raw "Failed to fetch"', async () => {
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submitStake()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
  })

  it.each([500, 504])(
    'a %i answer to a stake submission shows the not-confirmed sentence, because a gateway may have forwarded it',
    async (status) => {
      mockStakeNetwork(() =>
        Promise.reject(
          Object.assign(new Error(`Request failed with status code ${status}`), {
            code: 'ERR_BAD_RESPONSE',
            response: { status },
          }),
        ),
      )
      await submitStake()

      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
    },
  )

  it.each([-32001, -32603])(
    'a stake submission that gets a %i error body, which the network returns when it cannot rule out that the transaction was queued, shows the not-confirmed sentence',
    async (code) => {
      mockStakeNetwork(() => Promise.reject({ code, message: 'could not submit transaction' }))
      await submitStake()

      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
      expect(screen.getByRole('alert')).not.toHaveClass('text-lp-danger')
    },
  )

  it('an unstake request the network reports as DUPLICATE shows the not-confirmed sentence, in ink rather than red', async () => {
    mockStakeNetwork(() => Promise.resolve({ status: 'DUPLICATE', hash: 'deadbeef' }))
    await submitUnstake()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
    expect(screen.getByRole('alert')).not.toHaveClass('text-lp-danger')
  })

  it('a 4xx answer to an unstake request is a definite failure, shown as it is and in red', async () => {
    mockStakeNetwork(() =>
      Promise.reject(
        Object.assign(new Error('Request failed with status code 400'), {
          code: 'ERR_BAD_REQUEST',
          response: { status: 400 },
        }),
      ),
    )
    await submitUnstake()

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Request failed with status code 400'),
    )
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it('after an unknown stake outcome, an amount the form rejects is a definite failure and shows in red', async () => {
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submitStake()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))

    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '12.123456789' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Max 7 decimal places'))
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it('after an unknown unstake outcome, an amount the form rejects is a definite failure and shows in red', async () => {
    mockStakeNetwork(() => Promise.resolve({ status: 'DUPLICATE', hash: 'deadbeef' }))
    await submitUnstake()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))

    fireEvent.change(screen.getByTestId('unstake-amount'), { target: { value: '1.123456789' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request Unstake' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Max 7 decimal places'))
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it('a -32602 error body the network returns for a claim is a definite failure: nothing was sent, and it stays red', async () => {
    mockStakeNetwork(() => Promise.reject({ code: -32602, message: 'invalid transaction' }))
    await submitClaim()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Claim failed'))
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it.each([
    { slot: 'stake', submit: submitStake, again: () => fireEvent.click(screen.getByRole('button', { name: /^Stake$/i })) },
    { slot: 'unstake', submit: submitUnstake, again: () => fireEvent.click(screen.getByRole('button', { name: 'Request Unstake' })) },
    { slot: 'claim', submit: submitClaim, again: () => fireEvent.click(screen.getByTestId('claim-unstake')) },
  ])('after an unknown $slot outcome, a definite failure on the next press shows in red', async ({ submit, again }) => {
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submit()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))

    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(new Error('User rejected transaction'))
    again()
    expect(screen.queryByRole('alert')).toBeNull()

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('User rejected transaction'))
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it('keeps the form and the not-confirmed sentence when the refresh after an unknown outcome fails, instead of replacing the page with a load error', async () => {
    vi.mocked(apiClient.getLpEligibility)
      .mockResolvedValueOnce(mockEligibility)
      .mockRejectedValueOnce(new Error('eligibility unavailable'))
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submitStake()

    await waitFor(() => expect(queryClient.getQueryState(['lpEligibility'])?.status).toBe('error'))
    expect(screen.queryByText('Failed to load eligibility')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED)
    expect(screen.getByTestId('stake-amount')).toBeTruthy()
  })

  it('Stake and Request Unstake are disabled while the last refresh failed', async () => {
    vi.mocked(apiClient.getLpEligibility)
      .mockResolvedValueOnce(mockEligibility)
      .mockRejectedValueOnce(new Error('eligibility unavailable'))
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submitStake()

    await waitFor(() => expect(queryClient.getQueryState(['lpEligibility'])?.status).toBe('error'))
    expect(screen.getByRole('button', { name: /^Stake$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Request Unstake' })).toBeDisabled()
  })

  it('Claim stays available while the last refresh failed, because a repeated claim cannot pay out twice', async () => {
    const claimable = {
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) - 10,
    }
    vi.mocked(apiClient.getLpEligibility)
      .mockResolvedValueOnce(claimable)
      .mockRejectedValueOnce(new Error('eligibility unavailable'))
    mockStakeNetwork(() => Promise.reject(Object.assign(new Error('Failed to fetch'), { response: undefined })))
    await submitStake()

    await waitFor(() => expect(queryClient.getQueryState(['lpEligibility'])?.status).toBe('error'))
    expect(screen.getByTestId('claim-unstake')).toBeEnabled()
  })

  it('tells a provider their action may already have gone through when asking the network about it throws, instead of showing the raw error', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const pollTransactionMock = vi.fn().mockRejectedValue(new Error('Network Error'))

    vi.mocked(sdk.rpc.Server).mockImplementation(function () {
      return { sendTransaction: sendTransactionMock, pollTransaction: pollTransactionMock } as never
    } as unknown as typeof sdk.rpc.Server)
    vi.mocked(sdk.TransactionBuilder.fromXDR).mockReturnValue(TIMED_TX as never)
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
  })

  it('on a transaction with no time limit, tells a provider only to reload and check their stake before trying again, naming no time', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const pollTransactionMock = vi.fn().mockResolvedValue({ status: 'NOT_FOUND' })

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

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED_NO_TIME))
  })

  it('shows the same not-confirmed sentence for a claim as for a stake, because defaultSubmit serves every action', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) - 10,
    })
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const pollTransactionMock = vi.fn().mockResolvedValue({ status: 'NOT_FOUND' })

    vi.mocked(sdk.rpc.Server).mockImplementation(function () {
      return { sendTransaction: sendTransactionMock, pollTransaction: pollTransactionMock } as never
    } as unknown as typeof sdk.rpc.Server)
    vi.mocked(sdk.TransactionBuilder.fromXDR).mockReturnValue(TIMED_TX as never)
    vi.mocked(apiClient.getClaimUnstakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('claim-unstake'))
    fireEvent.click(screen.getByTestId('claim-unstake'))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(NOT_CONFIRMED))
    expect(screen.getByRole('alert')).not.toHaveClass('text-lp-danger')
  })

  it('shows the real refusal sentence for a code the network reports on the FIRST submit response, before any poll', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({
      status: 'ERROR',
      errorResult: { result: () => ({ switch: () => ({ name: 'txTooLate' }) }) },
    })
    const pollTransactionMock = vi.fn()

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

    await waitFor(() => {
      expect(screen.getByText(SUBMISSION_WINDOW_CLOSED)).toBeTruthy()
    })
    expect(pollTransactionMock).not.toHaveBeenCalled()
  })

  it('shows a real refusal sentence, naming the network code, when the network reports the transaction failed', async () => {
    const sendTransactionMock = vi.fn().mockResolvedValue({ status: 'PENDING', hash: 'deadbeef' })
    const pollTransactionMock = vi.fn().mockResolvedValue({
      status: 'FAILED',
      resultXdr: { result: () => ({ switch: () => ({ name: 'txFailed' }) }) },
    })

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

    await waitFor(() => {
      expect(screen.getByText('Submission failed (FAILED, txFailed)')).toBeTruthy()
    })
    expect(screen.getByRole('alert')).toHaveClass('text-lp-danger')
  })

  it('shows the plain stake-more line alongside an unrelated unbonding balance, since the two refusals no longer share one sentence', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      eligible: false,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) + 3600,
    })

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/You need at least 500\.00 USDC staked to take orders\./)).toBeTruthy()
      expect(screen.queryByText(/not taking orders/i)).toBeNull()
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

  it('refreshes eligibility even when a stake submission errors', async () => {
    vi.mocked(apiClient.getStakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
    const mockSubmit = vi.fn().mockRejectedValue(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('stake-amount'))
    fireEvent.change(screen.getByTestId('stake-amount'), { target: { value: '50' } })
    fireEvent.click(screen.getByRole('button', { name: /^Stake$/i }))

    await waitFor(() => expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(2))
  })

  it('refreshes eligibility even when a request-unstake submission errors', async () => {
    vi.mocked(apiClient.getRequestUnstakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
    const mockSubmit = vi.fn().mockRejectedValue(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('unstake-amount'))
    fireEvent.change(screen.getByTestId('unstake-amount'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request Unstake' }))

    await waitFor(() => expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(2))
  })

  it('refreshes eligibility even when a claim submission errors', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({
      ...mockEligibility,
      unbonding: '700000000',
      unbond_available_at: Math.floor(Date.now() / 1000) - 10,
    })
    vi.mocked(apiClient.getClaimUnstakeTx).mockResolvedValue({ xdr: 'XDR', networkPassphrase: 'np' })
    const mockSubmit = vi.fn().mockRejectedValue(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <StakeForm submitFn={mockSubmit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('claim-unstake'))
    fireEvent.click(screen.getByTestId('claim-unstake'))

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
