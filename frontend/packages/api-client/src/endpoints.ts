import { ApiClient } from './http'
import { Quote, Order, OrderStatus, Rate, CreateOrderResponse, TxEnvelope,
  Lp, LpStatus, LpMe, PaymentMethod, AdminConfig, Assignment, Eligibility, Rail,
  NotificationsResponse, Market, PostDisputeResponse, DisputeReason,
  UserProfile, OrderRisk, MetricsOverview, MetricsRange, LpEarnings } from './types'

export const getNotifications = (c: ApiClient) =>
  c.request<NotificationsResponse>('GET', '/notifications')

export const markNotificationsRead = (c: ApiClient) =>
  c.request<{ ok: boolean }>('POST', '/notifications/read')

export const getRate = (c: ApiClient, fiat = 'IDR') =>
  c.request<Rate>('GET', `/rate?fiat=${encodeURIComponent(fiat)}`)

export const getMarkets = (c: ApiClient) =>
  c.request<Market[]>('GET', '/markets')

export const createQuote = (
  c: ApiClient,
  b: {
    flow: 'TOP_UP' | 'WITHDRAW'
    rail: 'BANK' | 'QRIS' | 'EWALLET'
    usdcAmount?: string
    fiatAmount?: string
  },
) => c.request<Quote>('POST', '/quotes', b)

export const createOrder = (
  c: ApiClient,
  b: { quoteId: string; userPaymentMethod?: string },
) => c.request<CreateOrderResponse>('POST', '/orders', b)

export const getOrders = (c: ApiClient) => c.request<Order[]>('GET', '/orders')
export const getOrder = (c: ApiClient, id: string) => c.request<Order>('GET', `/orders/${id}`)
export const cancelOrder = (c: ApiClient, id: string) => c.request<Order>('POST', `/orders/${id}/cancel`)

export const getMarkPaidTx = (c: ApiClient, id: string) => c.request<TxEnvelope>('GET', `/orders/${id}/tx/mark-paid`)

export const getMyProfile = (c: ApiClient) => c.request<UserProfile>('GET', '/profile')

export const uploadProof = (
  c: ApiClient,
  id: string,
  file: File | Blob,
  meta?: { rrn?: string; paidAmount?: string; paidAt?: string },
) => {
  const form = new FormData()
  form.append('file', file)
  if (meta?.rrn) form.append('rrn', meta.rrn)
  if (meta?.paidAmount) form.append('paidAmount', meta.paidAmount)
  if (meta?.paidAt) form.append('paidAt', meta.paidAt)
  return c.request<Order>('POST', `/orders/${id}/proof`, form)
}

export const uploadDisputeEvidence = (c: ApiClient, id: string, file: File | Blob) => {
  const form = new FormData()
  form.append('file', file)
  return c.request<{ evidence_url: string }>('POST', `/orders/${id}/dispute-evidence`, form)
}

export const downloadOrderProof = (c: ApiClient, id: string) =>
  c.requestBlob('GET', `/orders/${id}/proof`)

export const downloadDisputeEvidence = (c: ApiClient, id: string) =>
  c.requestBlob('GET', `/orders/${id}/dispute-evidence`)

export const postDispute = (
  c: ApiClient,
  id: string,
  b: { reason: DisputeReason; note: string; evidenceUrl?: string },
) => c.request<PostDisputeResponse>('POST', `/orders/${id}/dispute`, b)

export const getLps = (c: ApiClient, status?: LpStatus) =>
  c.request<Lp[]>('GET', status ? `/admin/lps?status=${encodeURIComponent(status)}` : '/admin/lps')

export const setLpStatus = (c: ApiClient, id: string, action: 'approve' | 'suspend' | 'revoke', note?: string) =>
  c.request<Lp>('POST', `/admin/lps/${id}/${action}`, note !== undefined ? { note } : {})

export const registerLp = (
  c: ApiClient,
  b: { stellarAddress: string; contact: string; liquidityProof?: string; approve?: boolean },
) => c.request<Lp>('POST', '/admin/lps', b)

export const getAdminConfig = (c: ApiClient) =>
  c.request<AdminConfig>('GET', '/admin/config')

export const patchAdminConfig = (c: ApiClient, patch: Partial<{
  spreadBps: number; platformFeeBps: number; lpFeeBps: number
  platformWallet: string; paused: boolean

  requireProof: boolean; autoRefund: boolean
  postSettleDisputeWindowSecs: number
  payWindowSecs: number; confirmWindowSecs: number; disputeWindowSecs: number
  minOrder: string; maxOrder: string
}>) =>
  c.request<AdminConfig>('PATCH', '/admin/config', patch)

export const getAdminOrders = (c: ApiClient, status?: OrderStatus) =>
  c.request<Order[]>('GET', status ? `/admin/orders?status=${encodeURIComponent(status)}` : '/admin/orders')

export const getAdminOrderRisk = (c: ApiClient, id: string) =>
  c.request<OrderRisk>('GET', `/admin/orders/${id}/risk`)

export const getMetricsOverview = (c: ApiClient, range: MetricsRange) =>
  c.request<MetricsOverview>('GET', `/admin/metrics/overview?range=${encodeURIComponent(range)}`)

export const applyLp = (c: ApiClient, b: { contact: string; liquidityProof: string }) =>
  c.request<Lp>('POST', '/lp/apply', b)

export const getLpMe = (c: ApiClient) =>
  c.request<LpMe | null>('GET', '/lp/me')

export const getLpEarnings = (c: ApiClient) =>
  c.request<LpEarnings>('GET', '/lp/earnings')

export const heartbeat = (c: ApiClient) =>
  c.request<{ ok: boolean }>('POST', '/lp/heartbeat')

export const setAvailability = (c: ApiClient, available: boolean) =>
  c.request<{ ok: boolean }>('POST', '/lp/availability', { available })

export const addPaymentMethod = (c: ApiClient, b: { rail: Rail; label: string; details: string }) =>
  c.request<PaymentMethod>('POST', '/lp/payment-methods', b)

export const updatePaymentMethod = (c: ApiClient, id: string, patch: Partial<{ rail: Rail; label: string; details: string; active: boolean }>) =>
  c.request<PaymentMethod>('PATCH', `/lp/payment-methods/${id}`, patch)

export const deletePaymentMethod = (c: ApiClient, id: string) =>
  c.request<{ ok: boolean }>('DELETE', `/lp/payment-methods/${id}`)

export const getAssignments = (c: ApiClient) =>
  c.request<Assignment[]>('GET', '/lp/assignments')

export const getLpEligibility = (c: ApiClient) =>
  c.request<Eligibility>('GET', '/lp/eligibility')

export const getStakeTx = (c: ApiClient, amount: string) =>
  c.request<TxEnvelope>('GET', `/lp/tx/stake?amount=${encodeURIComponent(amount)}`)

export const getRequestUnstakeTx = (c: ApiClient, amount: string) =>
  c.request<TxEnvelope>('GET', `/lp/tx/request-unstake?amount=${encodeURIComponent(amount)}`)

export const getClaimUnstakeTx = (c: ApiClient) =>
  c.request<TxEnvelope>('GET', '/lp/tx/claim-unstake')

export const getCreateTradeTx = (c: ApiClient, orderId: string) =>
  c.request<TxEnvelope>('GET', `/orders/${orderId}/tx/create-trade`)

export const getConfirmReleaseTx = (c: ApiClient, orderId: string) =>
  c.request<TxEnvelope>('GET', `/orders/${orderId}/tx/confirm-release`)

export const getRaiseDisputeTx = (c: ApiClient, orderId: string) =>
  c.request<TxEnvelope>('GET', `/orders/${orderId}/tx/raise-dispute`)

export const getResolveTx = (c: ApiClient, orderId: string, outcome: 'release' | 'refund') =>
  c.request<TxEnvelope>('GET', `/orders/${orderId}/tx/resolve?outcome=${outcome}`)

export const getSlashTx = (c: ApiClient, orderId: string, amount: string) =>
  c.request<TxEnvelope>('GET', `/orders/${orderId}/tx/slash?amount=${encodeURIComponent(amount)}`)
