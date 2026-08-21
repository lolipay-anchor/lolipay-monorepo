import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
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
  usePathname: vi.fn(() => '/payment-methods'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(),
    getLpMe: vi.fn(),
    addPaymentMethod: vi.fn(),
    updatePaymentMethod: vi.fn(),
    deletePaymentMethod: vi.fn(),
  }
})

const PaymentMethodsPage = (await import('@/app/payment-methods/page')).default
const apiClient = await import('@lolipay/api-client')

type PM = {
  id: string
  lpId: string
  rail: 'BANK' | 'QRIS' | 'EWALLET'
  label: string
  details: string
  currency: string
  active: boolean
}

function makeLpMe(methods: PM[] = []) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online: false,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: methods,
  }
}

const samplePm: PM = {
  id: 'pm-1',
  lpId: 'lp-1',
  rail: 'BANK',
  label: 'My BCA',
  details: 'BCA 1234567',
  currency: 'IDR',
  active: true,
}

describe('PaymentMethodsPage', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe())
  })

  it('shows loading state initially', () => {
    vi.mocked(apiClient.getLpMe).mockReturnValue(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    expect(screen.getByText(/Loading/i)).toBeTruthy()
  })

  it('shows empty state when there are no payment methods', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/No payment methods yet/i)).toBeTruthy()
    })
  })

  it('renders existing payment methods', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe([samplePm]))

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('My BCA')).toBeTruthy()
      expect(screen.getByText(/BCA 1234567/i)).toBeTruthy()
    })
  })

  it('opens add sheet and calls addPaymentMethod on submit', async () => {
    vi.mocked(apiClient.addPaymentMethod).mockResolvedValue({
      ...samplePm,
      id: 'pm-new',
      label: 'Mandiri',
      details: 'Mandiri 9876543',
    })

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByText(/\+ Add Payment Method/i))
    fireEvent.click(screen.getByText(/\+ Add Payment Method/i))

    await waitFor(() => screen.getByTestId('pm-label'))

    fireEvent.change(screen.getByTestId('pm-label'), {
      target: { value: 'Mandiri' },
    })
    fireEvent.change(screen.getByTestId('pm-details'), {
      target: { value: 'Mandiri 9876543' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/i }))

    await waitFor(() => {
      expect(apiClient.addPaymentMethod).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          rail: 'BANK',
          label: 'Mandiri',
          details: 'Mandiri 9876543',
        }),
      )
    })
  })

  it('opens edit sheet and calls updatePaymentMethod on save', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe([samplePm]))
    vi.mocked(apiClient.updatePaymentMethod).mockResolvedValue({
      ...samplePm,
      label: 'BCA Updated',
    })

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByText('My BCA'))

    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }))

    await waitFor(() => screen.getByTestId('pm-edit-label'))

    fireEvent.change(screen.getByTestId('pm-edit-label'), {
      target: { value: 'BCA Updated' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))

    await waitFor(() => {
      expect(apiClient.updatePaymentMethod).toHaveBeenCalledWith(
        expect.anything(),
        'pm-1',
        expect.objectContaining({ label: 'BCA Updated' }),
      )
    })
  })

  it('opens delete confirm sheet and calls deletePaymentMethod on confirm', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe([samplePm]))
    vi.mocked(apiClient.deletePaymentMethod).mockResolvedValue({ ok: true })

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByText('My BCA'))
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }))

    await waitFor(() => screen.getByText(/Confirm Delete/i))
    fireEvent.click(screen.getByRole('button', { name: /^Confirm Delete$/i }))

    await waitFor(() => {
      expect(apiClient.deletePaymentMethod).toHaveBeenCalledWith(
        expect.anything(),
        'pm-1',
      )
    })
  })

  it('does NOT call deletePaymentMethod when Cancel is clicked', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe([samplePm]))

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByText('My BCA'))
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/i }))

    await waitFor(() => screen.getByText(/Confirm Delete/i))
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }))

    await waitFor(() => {
      expect(apiClient.deletePaymentMethod).not.toHaveBeenCalled()
    })
  })

  it('shows active/inactive badge for payment methods', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(
      makeLpMe([
        samplePm,
        { ...samplePm, id: 'pm-2', label: 'QRIS Shop', active: false },
      ]),
    )

    render(
      <TestProviders kit={fakeKit}>
        <PaymentMethodsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeTruthy()
      expect(screen.getByText('Inactive')).toBeTruthy()
    })
  })
})
