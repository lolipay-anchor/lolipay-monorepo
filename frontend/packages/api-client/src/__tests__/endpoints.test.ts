import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiClient } from '../http'
import { getRate, getMarkets, createQuote, createOrder, getOrders, getOrder, cancelOrder, getMarkPaidTx,
  getLps, setLpStatus, getAdminConfig, patchAdminConfig, getAdminOrders,
  applyLp, getLpMe, getLpEarnings, heartbeat, setAvailability,
  addPaymentMethod, updatePaymentMethod, deletePaymentMethod,
  getAssignments, getLpEligibility, getStakeTx,
  getCreateTradeTx, getConfirmReleaseTx,
  uploadProof, uploadDisputeEvidence, postDispute,
  downloadOrderProof, downloadDisputeEvidence, getMyProfile, getAdminOrderRisk,
  getMetricsOverview, attestFiatPaid } from '../endpoints'
import type { Rate, Market, Quote, Order, CreateOrderResponse, TxEnvelope,
  Lp, LpMe, LpEarnings, AdminConfig, Assignment, Eligibility, PostDisputeResponse,
  UserProfile, OrderRisk, MetricsOverview } from '../types'

describe('endpoints', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function makeClient(): { client: ApiClient; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ baseUrl: 'https://api.test', getToken: () => null, setToken: () => {} })
    return { client, fetchMock }
  }

  it('attestFiatPaid: POSTs the evidence to the order path with the id encoded, so a hostile id cannot reach another route', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ orderId: 'a/b#c', submission: 'SUCCESS' }) })

    await attestFiatPaid(client, 'a/b#c', 'BCA 12345')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/orders/a%2Fb%23c/attest')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ evidence: 'BCA 12345' })
  })

  it('getRate: GETs /rate?fiat=IDR and returns Rate object', async () => {
    const { client, fetchMock } = makeClient()
    const mockRate: Rate = { asset: 'USDC', fiat: 'IDR', rate: '16240', ts: '2026-06-28T00:00:00Z' }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockRate })

    const result = await getRate(client)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/rate?fiat=IDR')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(mockRate)
    expect(result.asset).toBe('USDC')
    expect(result.fiat).toBe('IDR')
    expect(result.rate).toBe('16240')
    expect(result.ts).toBe('2026-06-28T00:00:00Z')
  })

  it('getRate: uses custom fiat param when provided', async () => {
    const { client, fetchMock } = makeClient()
    const mockRate: Rate = { asset: 'USDC', fiat: 'SGD', rate: '1.35', ts: '2026-06-28T00:00:00Z' }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockRate })

    await getRate(client, 'SGD')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/rate?fiat=SGD')
  })

  it('getMarkets: GETs /markets (no auth) and returns Market[] incl. disabled corridors', async () => {
    const { client, fetchMock } = makeClient()
    const mockMarkets: Market[] = [
      { code: 'IDR', country: 'Indonesia', currency_symbol: 'Rp', locale: 'id-ID', rail_name: 'QRIS', enabled: true },
      { code: 'PHP', country: 'Philippines', currency_symbol: '₱', locale: 'en-PH', rail_name: 'InstaPay', enabled: false },
    ]
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockMarkets })

    const result = await getMarkets(client)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/markets')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBeUndefined()
    expect(result).toEqual(mockMarkets)
    expect(result[0].code).toBe('IDR')
    expect(result[0].enabled).toBe(true)
    expect(result[1].code).toBe('PHP')
    expect(result[1].enabled).toBe(false)
  })

  it('createQuote: POSTs /quotes with correct body and returns Quote', async () => {
    const { client, fetchMock } = makeClient()
    const mockQuote: Quote = {
      quote_id: 'q_abc123',
      fiat_amount: '1624000',
      rate: '16240',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: '2026-06-28T00:05:00Z',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockQuote })

    const body = { flow: 'TOP_UP' as const, rail: 'BANK' as const, usdcAmount: '1000000000' }
    const result = await createQuote(client, body)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/quotes')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody).toEqual(body)
    expect(result).toEqual(mockQuote)
    expect(result.quote_id).toBe('q_abc123')
    expect(result.fiat_amount).toBe('1624000')
    expect(result.rate).toBe('16240')
    expect(result.platform_fee_bps).toBe(30)
    expect(result.lp_fee_bps).toBe(120)
  })

  it('createOrder: POSTs /orders and returns CreateOrderResponse (TOP_UP has no create_trade_params)', async () => {
    const { client, fetchMock } = makeClient()
    const mockOrder: Order = {
      id: 'ord_xyz',
      trade_id: 'trade_001',
      user_address: 'GUSER',
      lp_wallet: 'GLP',
      flow: 'TOP_UP',
      rail: 'BANK',
      usdc_amount: '1000000000',
      fiat_amount: '1624000',
      fiat_currency: 'IDR',
      rate_snapshot: '16240',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      status: 'CREATED',
      pay_deadline: 1751000000,
      confirm_deadline: 1751003600,
      dispute_deadline: 1751007200,
      expires_at: '2026-06-28T01:00:00Z',
      created_at: '2026-06-28T00:00:00Z',
    }
    const mockResponse: CreateOrderResponse = { order: mockOrder }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockResponse })

    const result = await createOrder(client, { quoteId: 'q_abc123' })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.quoteId).toBe('q_abc123')
    expect(result.order).toEqual(mockOrder)
    expect(result.create_trade_params).toBeUndefined()
  })

  it('createOrder: returns create_trade_params when present (WITHDRAW flow)', async () => {
    const { client, fetchMock } = makeClient()
    const mockResponse: CreateOrderResponse = {
      order: {
        id: 'ord_w1',
        trade_id: 'trade_w1',
        user_address: 'GUSER',
        lp_wallet: 'GLP',
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdc_amount: '1000000000',
        fiat_amount: '1624000',
        fiat_currency: 'IDR',
        rate_snapshot: '16240',
        platform_fee_bps: 30,
        lp_fee_bps: 120,
        status: 'CREATED',
        pay_deadline: 1751000000,
        confirm_deadline: 1751003600,
        dispute_deadline: 1751007200,
        expires_at: '2026-06-28T01:00:00Z',
        created_at: '2026-06-28T00:00:00Z',
      },
      create_trade_params: {
        trade_id: 'trade_w1',
        usdc_provider: 'GUSER',
        usdc_recipient: 'GLP',
        confirmer: 'GLP',
        usdc_amount: '1000000000',
        pay_deadline: 1751000000,
        confirm_deadline: 1751003600,
        dispute_deadline: 1751007200,
        platform_wallet: 'GPLATFORM',
        platform_fee_bps: 30,
        lp_fee_bps: 120,
      },
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockResponse })

    const result = await createOrder(client, { quoteId: 'q_w1' })
    expect(result.create_trade_params).toBeDefined()
    expect(result.create_trade_params!.trade_id).toBe('trade_w1')
  })

  it('getOrders: GETs /orders', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })

    const result = await getOrders(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders')
    expect(opts.method).toBe('GET')
    expect(Array.isArray(result)).toBe(true)
  })

  it('getOrder: GETs /orders/:id', async () => {
    const { client, fetchMock } = makeClient()
    const mockOrder = { id: 'ord_123', status: 'FUNDED' } as unknown as Order
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockOrder })

    const result = await getOrder(client, 'ord_123')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_123')
    expect(opts.method).toBe('GET')
    expect(result.id).toBe('ord_123')
  })

  it('cancelOrder: POSTs /orders/:id/cancel', async () => {
    const { client, fetchMock } = makeClient()
    const mockOrder = { id: 'ord_456', status: 'CANCELLED' } as unknown as Order
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockOrder })

    const result = await cancelOrder(client, 'ord_456')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_456/cancel')
    expect(opts.method).toBe('POST')
    expect(result.status).toBe('CANCELLED')
  })

  it('getMarkPaidTx: GETs /orders/:id/tx/mark-paid and returns TxEnvelope', async () => {
    const { client, fetchMock } = makeClient()
    const mockEnvelope: TxEnvelope = {
      xdr: 'AAAAAQAAAAC...',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEnvelope })

    const result = await getMarkPaidTx(client, 'ord_789')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_789/tx/mark-paid')
    expect(opts.method).toBe('GET')
    expect(result.xdr).toBe('AAAAAQAAAAC...')
    expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('getMyProfile: GETs /profile and returns the snake_case UserProfile', async () => {
    const { client, fetchMock } = makeClient()
    const mockProfile: UserProfile = {
      tier: 'SILVER',
      completed_trades: 7,
      disputes_lost: 0,
      completion_rate: 1,
      daily_limit_usdc: 300,
      daily_used_usdc: 40,
      daily_remaining_usdc: 260,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockProfile })

    const result = await getMyProfile(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/profile')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(mockProfile)
    expect(result.tier).toBe('SILVER')
    expect(result.daily_remaining_usdc).toBe(260)
  })

  it('getLps: GETs /admin/lps (no filter)', async () => {
    const { client, fetchMock } = makeClient()
    const mockLp: Lp = {
      id: 'lp_1', stellarAddress: 'GALP', status: 'PENDING',
      contact: 'lp@example.com', liquidityProof: 'https://proof', approvalNote: null,
      online: false, lastHeartbeatAt: null, createdAt: '2026-06-01T00:00:00Z', approvedAt: null,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [mockLp] })

    const result = await getLps(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/lps')
    expect(opts.method).toBe('GET')
    expect(result).toHaveLength(1)
    expect(result[0].stellarAddress).toBe('GALP')
    expect(result[0].status).toBe('PENDING')
  })

  it('getLps: appends ?status= filter when provided', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })

    await getLps(client, 'APPROVED')

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/lps?status=APPROVED')
  })

  it('setLpStatus: POSTs /admin/lps/:id/approve with note body and returns Lp', async () => {
    const { client, fetchMock } = makeClient()
    const mockLp: Lp = {
      id: 'lp_1', stellarAddress: 'GALP', status: 'APPROVED',
      contact: 'lp@example.com', liquidityProof: 'https://proof', approvalNote: 'Verified',
      online: false, lastHeartbeatAt: null, createdAt: '2026-06-01T00:00:00Z', approvedAt: '2026-06-15T00:00:00Z',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockLp })

    const result = await setLpStatus(client, 'lp_1', 'approve', 'Verified')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/lps/lp_1/approve')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.note).toBe('Verified')
    expect(result.status).toBe('APPROVED')
    expect(result.approvalNote).toBe('Verified')
  })

  it('setLpStatus: omits note from body when not provided', async () => {
    const { client, fetchMock } = makeClient()
    const mockLp: Lp = {
      id: 'lp_2', stellarAddress: 'GALP2', status: 'SUSPENDED',
      contact: 'lp2@example.com', liquidityProof: 'https://proof2', approvalNote: null,
      online: false, lastHeartbeatAt: null, createdAt: '2026-06-01T00:00:00Z', approvedAt: null,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockLp })

    const result = await setLpStatus(client, 'lp_2', 'suspend')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/lps/lp_2/suspend')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody).not.toHaveProperty('note')
    expect(result.status).toBe('SUSPENDED')
  })

  it('getAdminConfig: GETs /admin/config and returns camelCase AdminConfig', async () => {
    const { client, fetchMock } = makeClient()
    const mockConfig: AdminConfig = {
      id: 1, spreadBps: 50, platformFeeBps: 30, lpFeeBps: 120,
      platformWallet: 'GPLATFORM', minOrder: '10000000', maxOrder: '100000000000',
      payWindowSecs: 3600, confirmWindowSecs: 7200, disputeWindowSecs: 86400,
      paused: false, updatedAt: '2026-06-01T00:00:00Z',
      requireProof: false, autoRefund: false, postSettleDisputeWindowSecs: 3600,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockConfig })

    const result = await getAdminConfig(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/config')
    expect(opts.method).toBe('GET')
    expect(result.spreadBps).toBe(50)
    expect(result.platformFeeBps).toBe(30)
    expect(result.lpFeeBps).toBe(120)
    expect(result.platformWallet).toBe('GPLATFORM')
    expect(result.minOrder).toBe('10000000')
    expect(result.paused).toBe(false)
  })

  it('patchAdminConfig: PATCHes /admin/config with partial body and returns updated AdminConfig', async () => {
    const { client, fetchMock } = makeClient()
    const mockConfig: AdminConfig = {
      id: 1, spreadBps: 60, platformFeeBps: 30, lpFeeBps: 120,
      platformWallet: 'GPLATFORM', minOrder: '10000000', maxOrder: '100000000000',
      payWindowSecs: 3600, confirmWindowSecs: 7200, disputeWindowSecs: 86400,
      paused: false, updatedAt: '2026-07-01T00:00:00Z',
      requireProof: false, autoRefund: false, postSettleDisputeWindowSecs: 3600,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockConfig })

    const patch = { spreadBps: 60 }
    const result = await patchAdminConfig(client, patch)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/config')
    expect(opts.method).toBe('PATCH')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.spreadBps).toBe(60)
    expect(result.spreadBps).toBe(60)
  })

  it('patchAdminConfig: accepts the Phase 5B anti-fraud + editable window/bounds fields', async () => {
    const { client, fetchMock } = makeClient()
    const mockConfig: AdminConfig = {
      id: 1, spreadBps: 60, platformFeeBps: 30, lpFeeBps: 120,
      platformWallet: 'GPLATFORM', minOrder: '20000000', maxOrder: '200000000000',
      payWindowSecs: 1800, confirmWindowSecs: 3600, disputeWindowSecs: 43200,
      paused: false, updatedAt: '2026-07-08T00:00:00Z',
      requireProof: true, autoRefund: true, postSettleDisputeWindowSecs: 1800,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockConfig })

    const patch = {
      requireProof: true,
      autoRefund: true,
      postSettleDisputeWindowSecs: 1800,
      payWindowSecs: 1800,
      confirmWindowSecs: 3600,
      disputeWindowSecs: 43200,
      minOrder: '20000000',
      maxOrder: '200000000000',
    }
    const result = await patchAdminConfig(client, patch)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/config')
    expect(opts.method).toBe('PATCH')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody).toEqual(patch)
    expect(result.requireProof).toBe(true)
    expect(result.autoRefund).toBe(true)
    expect(result.postSettleDisputeWindowSecs).toBe(1800)
  })

  it('getAdminOrders: GETs /admin/orders with optional status filter', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] })

    await getAdminOrders(client, 'DISPUTED')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/orders?status=DISPUTED')
    expect(opts.method).toBe('GET')
  })

  it('getAdminOrderRisk: GETs /admin/orders/:id/risk and returns the snake_case OrderRisk', async () => {
    const { client, fetchMock } = makeClient()
    const mockRisk: OrderRisk = {
      wallet_age_days: 42,
      user_dispute_velocity_30d: 1,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: { order_usdc: 50, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 0.5 },
      lp_completion: { completed_trades: 20, completion_rate: 0.95, member_since: '2026-01-01T00:00:00Z', online: true },
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockRisk })

    const result = await getAdminOrderRisk(client, 'order-1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/orders/order-1/risk')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(mockRisk)
    expect(result.wallet_age_days).toBe(42)
    expect(result.amount_vs_tier_limit.ratio).toBe(0.5)
  })

  it('getAdminOrderRisk: passes through a null wallet_age_days (unknown — treat as high risk)', async () => {
    const { client, fetchMock } = makeClient()
    const mockRisk: OrderRisk = {
      wallet_age_days: null,
      user_dispute_velocity_30d: 0,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: { order_usdc: 10, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 0.1 },
      lp_completion: null,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockRisk })

    const result = await getAdminOrderRisk(client, 'order-2')

    expect(result.wallet_age_days).toBeNull()
    expect(result.lp_completion).toBeNull()
  })

  it('getMetricsOverview: GETs /admin/metrics/overview?range=24h and returns the snake_case MetricsOverview', async () => {
    const { client, fetchMock } = makeClient()
    const mockOverview: MetricsOverview = {
      range: '24h',
      volume_usdc: 1234.56,
      fees_usdc: 12.3,
      avg_settle_secs: 112.5,
      open_disputes: 2,
      orders_count: 40,
      daily_bars: [{ date: '2026-07-08', volume_usdc: 1234.56 }],
      flow_mix: [{ flow: 'TOP_UP', count: 20, volume_usdc: 600 }],
      top_lps: [{ lp_id: 'lp_1', address: 'GALP', volume_usdc: 500, trades: 12 }],
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockOverview })

    const result = await getMetricsOverview(client, '24h')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/admin/metrics/overview?range=24h')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(mockOverview)
    expect(result.range).toBe('24h')
    expect(result.avg_settle_secs).toBe(112.5)
    expect(result.top_lps[0].address).toBe('GALP')
  })

  it('getMetricsOverview: uses the range param for 7d and 30d', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        range: '7d', volume_usdc: 0, fees_usdc: 0, avg_settle_secs: null,
        open_disputes: 0, orders_count: 0, daily_bars: [], flow_mix: [], top_lps: [],
      }),
    })

    await getMetricsOverview(client, '7d')
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/admin/metrics/overview?range=7d')

    await getMetricsOverview(client, '30d')
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.test/admin/metrics/overview?range=30d')
  })

  it('getMetricsOverview: passes through null avg_settle_secs and zeroed empty-range fields', async () => {
    const { client, fetchMock } = makeClient()
    const mockOverview: MetricsOverview = {
      range: '30d', volume_usdc: 0, fees_usdc: 0, avg_settle_secs: null,
      open_disputes: 0, orders_count: 0, daily_bars: [], flow_mix: [], top_lps: [],
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockOverview })

    const result = await getMetricsOverview(client, '30d')

    expect(result.avg_settle_secs).toBeNull()
    expect(result.volume_usdc).toBe(0)
    expect(result.daily_bars).toEqual([])
  })

  it('applyLp: POSTs /lp/apply with contact and liquidityProof', async () => {
    const { client, fetchMock } = makeClient()
    const mockLp: Lp = {
      id: 'lp_new', stellarAddress: 'GNEW', status: 'PENDING',
      contact: 'me@lp.com', liquidityProof: 'https://proof', approvalNote: null,
      online: false, lastHeartbeatAt: null, createdAt: '2026-07-01T00:00:00Z', approvedAt: null,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockLp })

    const result = await applyLp(client, { contact: 'me@lp.com', liquidityProof: 'https://proof' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/apply')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.contact).toBe('me@lp.com')
    expect(sentBody.liquidityProof).toBe('https://proof')
    expect(result.status).toBe('PENDING')
    expect(result.id).toBe('lp_new')
  })

  it('getLpMe: GETs /lp/me and returns LpMe with paymentMethods', async () => {
    const { client, fetchMock } = makeClient()
    const mockLpMe: LpMe = {
      id: 'lp_1', stellarAddress: 'GALP', status: 'APPROVED',
      contact: 'lp@example.com', liquidityProof: 'https://proof', approvalNote: 'ok',
      online: true, lastHeartbeatAt: '2026-07-01T10:00:00Z', createdAt: '2026-06-01T00:00:00Z', approvedAt: '2026-06-15T00:00:00Z',
      paymentMethods: [
        { id: 'pm_1', lpId: 'lp_1', rail: 'BANK', label: 'BCA', details: '12345678', currency: 'IDR', active: true },
      ],
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockLpMe })

    const result = await getLpMe(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/me')
    expect(opts.method).toBe('GET')
    expect(result).not.toBeNull()
    expect(result!.id).toBe('lp_1')
    expect(result!.paymentMethods).toHaveLength(1)
    expect(result!.paymentMethods[0].rail).toBe('BANK')
  })

  it('getLpMe: passes through null when LP has never applied', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => null })

    const result = await getLpMe(client)

    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/me')
    expect(result).toBeNull()
  })

  it('getLpEarnings: GETs /lp/earnings and returns the snake_case LpEarnings', async () => {
    const { client, fetchMock } = makeClient()
    const mockEarnings: LpEarnings = {
      today_trades: 3,
      today_earned_usdc: 1.8,
      today_volume_usdc: 150,
      week_bars: [
        { date: '2026-07-02', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-03', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-04', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-05', volume_usdc: 20, earned_usdc: 0.2 },
        { date: '2026-07-06', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-07', volume_usdc: 0, earned_usdc: 0 },
        { date: '2026-07-08', volume_usdc: 150, earned_usdc: 1.8 },
      ],
      all_time_trades: 42,
      all_time_earned_usdc: 5,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEarnings })

    const result = await getLpEarnings(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/earnings')
    expect(opts.method).toBe('GET')
    expect(result).toEqual(mockEarnings)
    expect(result.week_bars).toHaveLength(7)
    expect(result.all_time_trades).toBe(42)
  })

  it('getLpEarnings: passes through the zeroed/empty shape for a brand-new LP', async () => {
    const { client, fetchMock } = makeClient()
    const mockEarnings: LpEarnings = {
      today_trades: 0,
      today_earned_usdc: 0,
      today_volume_usdc: 0,
      week_bars: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-07-0${i + 2}`,
        volume_usdc: 0,
        earned_usdc: 0,
      })),
      all_time_trades: 0,
      all_time_earned_usdc: 0,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEarnings })

    const result = await getLpEarnings(client)

    expect(result.today_trades).toBe(0)
    expect(result.week_bars).toHaveLength(7)
    expect(result.week_bars.every((b) => b.volume_usdc === 0 && b.earned_usdc === 0)).toBe(true)
  })

  it('heartbeat: POSTs /lp/heartbeat and returns { ok: true }', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })

    const result = await heartbeat(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/heartbeat')
    expect(opts.method).toBe('POST')
    expect(result.ok).toBe(true)
  })

  it('setAvailability: POSTs /lp/availability with available boolean', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })

    const result = await setAvailability(client, true)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/availability')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.available).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('addPaymentMethod: POSTs /lp/payment-methods and returns PaymentMethod', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      id: 'pm_2', lpId: 'lp_1', rail: 'QRIS', label: 'My QRIS', details: 'qris://...', currency: 'IDR', active: true,
    }) })

    const result = await addPaymentMethod(client, { rail: 'QRIS', label: 'My QRIS', details: 'qris://...' })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/payment-methods')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.rail).toBe('QRIS')
    expect(sentBody.label).toBe('My QRIS')
    expect(result.id).toBe('pm_2')
    expect(result.active).toBe(true)
  })

  it('updatePaymentMethod: PATCHes /lp/payment-methods/:id', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      id: 'pm_1', lpId: 'lp_1', rail: 'BANK', label: 'BCA Updated', details: '99999999', currency: 'IDR', active: false,
    }) })

    const result = await updatePaymentMethod(client, 'pm_1', { label: 'BCA Updated', active: false })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/payment-methods/pm_1')
    expect(opts.method).toBe('PATCH')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody.label).toBe('BCA Updated')
    expect(sentBody.active).toBe(false)
    expect(result.label).toBe('BCA Updated')
    expect(result.active).toBe(false)
  })

  it('deletePaymentMethod: DELETEs /lp/payment-methods/:id', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) })

    const result = await deletePaymentMethod(client, 'pm_1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/payment-methods/pm_1')
    expect(opts.method).toBe('DELETE')
    expect(result.ok).toBe(true)
  })

  it('getAssignments: GETs /lp/assignments and returns Assignment[] with order and create_trade_params', async () => {
    const { client, fetchMock } = makeClient()
    const mockOrder: Order = {
      id: 'ord_a1', trade_id: 'trade_a1',
      user_address: 'GUSER', lp_wallet: 'GALP',
      flow: 'TOP_UP', rail: 'BANK',
      usdc_amount: '1000000000', fiat_amount: '1624000', fiat_currency: 'IDR',
      rate_snapshot: '16240', platform_fee_bps: 30, lp_fee_bps: 120,
      status: 'MATCHED',
      pay_deadline: 1751000000, confirm_deadline: 1751003600, dispute_deadline: 1751007200,
      expires_at: '2026-07-01T01:00:00Z', created_at: '2026-07-01T00:00:00Z',
    }
    const mockAssignments: Assignment[] = [{
      order: mockOrder,
      create_trade_params: {
        trade_id: 'trade_a1', usdc_provider: 'GALP', usdc_recipient: 'GUSER',
        confirmer: 'GALP', usdc_amount: '1000000000',
        pay_deadline: 1751000000, confirm_deadline: 1751003600, dispute_deadline: 1751007200,
        platform_wallet: 'GPLATFORM', platform_fee_bps: 30, lp_fee_bps: 120,
      },
    }]
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockAssignments })

    const result = await getAssignments(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/assignments')
    expect(opts.method).toBe('GET')
    expect(result).toHaveLength(1)
    expect(result[0].order.id).toBe('ord_a1')
    expect(result[0].order.status).toBe('MATCHED')
    expect(result[0].create_trade_params).toBeDefined()
    expect(result[0].create_trade_params!.trade_id).toBe('trade_a1')
    expect(result[0].create_trade_params!.usdc_provider).toBe('GALP')
  })

  it('getLpEligibility: GETs /lp/eligibility and returns Eligibility', async () => {
    const { client, fetchMock } = makeClient()
    const mockEligibility: Eligibility = {
      staked: '5000000000', unbonding: '0', unbond_available_at: 0,
      min_stake: '1000000000', eligible: true,
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEligibility })

    const result = await getLpEligibility(client)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/eligibility')
    expect(opts.method).toBe('GET')
    expect(result.staked).toBe('5000000000')
    expect(result.min_stake).toBe('1000000000')
    expect(result.eligible).toBe(true)
    expect(result.unbonding).toBe('0')
  })

  it('getStakeTx: GETs /lp/tx/stake?amount=<amount> and returns TxEnvelope', async () => {
    const { client, fetchMock } = makeClient()
    const mockEnvelope: TxEnvelope = {
      xdr: 'AAAASTAKE...',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEnvelope })

    const result = await getStakeTx(client, '5000000000')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/lp/tx/stake?amount=5000000000')
    expect(opts.method).toBe('GET')
    expect(result.xdr).toBe('AAAASTAKE...')
    expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('getCreateTradeTx: GETs /orders/:id/tx/create-trade and returns TxEnvelope', async () => {
    const { client, fetchMock } = makeClient()
    const mockEnvelope: TxEnvelope = {
      xdr: 'AAAACREATE...',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEnvelope })

    const result = await getCreateTradeTx(client, 'ord_ct1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_ct1/tx/create-trade')
    expect(opts.method).toBe('GET')
    expect(result.xdr).toBe('AAAACREATE...')
    expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })

  it('getConfirmReleaseTx: GETs /orders/:id/tx/confirm-release and returns TxEnvelope', async () => {
    const { client, fetchMock } = makeClient()
    const mockEnvelope: TxEnvelope = {
      xdr: 'AAAACOFIRM...',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockEnvelope })

    const result = await getConfirmReleaseTx(client, 'ord_cr1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_cr1/tx/confirm-release')
    expect(opts.method).toBe('GET')
    expect(result.xdr).toBe('AAAACOFIRM...')
    expect(result.networkPassphrase).toBe('Test SDF Network ; September 2015')
  })
})

describe('endpoints — Phase 5B proof + dispute evidence uploads (multipart)', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function makeClient(): { client: ApiClient; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ baseUrl: 'https://api.test', getToken: () => 'jwt-token', setToken: () => {} })
    return { client, fetchMock }
  }

  it('uploadProof: POSTs /orders/:id/proof with a FormData body, no manual Content-Type header, and returns the updated order', async () => {
    const { client, fetchMock } = makeClient()
    const mockOrder = { id: 'ord_p1', status: 'FUNDED', proof_url: 'proofs/abc.jpg' } as unknown as Order
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockOrder })

    const file = new Blob(['fake-image-bytes'], { type: 'image/jpeg' })
    const result = await uploadProof(client, 'ord_p1', file)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_p1/proof')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeInstanceOf(FormData)

    const sentFile = (opts.body as FormData).get('file') as Blob
    expect(sentFile.size).toBe(file.size)
    expect(sentFile.type).toBe('image/jpeg')

    expect(opts.headers['Content-Type']).toBeUndefined()

    expect(opts.headers.Authorization).toBe('Bearer jwt-token')
    expect(result.proof_url).toBe('proofs/abc.jpg')
  })

  it('uploadDisputeEvidence: POSTs /orders/:id/dispute-evidence with a FormData body and returns { evidence_url }', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ evidence_url: 'evidence/ord_e1-user.png' }),
    })

    const file = new Blob(['fake-image-bytes'], { type: 'image/png' })
    const result = await uploadDisputeEvidence(client, 'ord_e1', file)

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_e1/dispute-evidence')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeInstanceOf(FormData)
    expect(opts.headers['Content-Type']).toBeUndefined()
    expect(result.evidence_url).toBe('evidence/ord_e1-user.png')
  })

  it('downloadOrderProof: GETs /orders/:id/proof with auth header and returns a Blob', async () => {
    const { client, fetchMock } = makeClient()
    const mockBlob = new Blob(['bytes'], { type: 'image/jpeg' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => mockBlob })

    const result = await downloadOrderProof(client, 'ord_p1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_p1/proof')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer jwt-token')
    expect(result).toBe(mockBlob)
  })

  it('downloadOrderProof: surfaces a 404 as ApiError instead of trying to parse a blob body as JSON', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: 'no payment proof uploaded for this order' }),
    })

    await expect(downloadOrderProof(client, 'ord_missing')).rejects.toThrow(
      /no payment proof uploaded/i,
    )
  })

  it('downloadDisputeEvidence: GETs /orders/:id/dispute-evidence with auth header and returns a Blob', async () => {
    const { client, fetchMock } = makeClient()
    const mockBlob = new Blob(['bytes'], { type: 'application/pdf' })
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, blob: async () => mockBlob })

    const result = await downloadDisputeEvidence(client, 'ord_e1')

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_e1/dispute-evidence')
    expect(opts.method).toBe('GET')
    expect(opts.headers.Authorization).toBe('Bearer jwt-token')
    expect(result).toBe(mockBlob)
  })
})

describe('endpoints — Phase 5B dispute metadata', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function makeClient(): { client: ApiClient; fetchMock: ReturnType<typeof vi.fn> } {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ baseUrl: 'https://api.test', getToken: () => null, setToken: () => {} })
    return { client, fetchMock }
  }

  it('postDispute: POSTs /orders/:id/dispute with reason/note/evidenceUrl and returns order + dispute_tx', async () => {
    const { client, fetchMock } = makeClient()
    const mockResponse: PostDisputeResponse = {
      order: { id: 'ord_di1', status: 'FIAT_PAID', dispute_by: 'user' } as unknown as Order,
      dispute_tx: { xdr: 'AAAADISPUTE...', networkPassphrase: 'Test SDF Network ; September 2015' },
    }
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => mockResponse })

    const result = await postDispute(client, 'ord_di1', {
      reason: 'PAYMENT_NOT_RECEIVED',
      note: 'Never received the transfer',
      evidenceUrl: 'evidence/ord_di1-user.jpg',
    })

    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/orders/ord_di1/dispute')
    expect(opts.method).toBe('POST')
    const sentBody = JSON.parse(opts.body)
    expect(sentBody).toEqual({
      reason: 'PAYMENT_NOT_RECEIVED',
      note: 'Never received the transfer',
      evidenceUrl: 'evidence/ord_di1-user.jpg',
    })
    expect(result.order.dispute_by).toBe('user')
    expect(result.dispute_tx.xdr).toBe('AAAADISPUTE...')
  })

  it('postDispute: omits evidenceUrl from the body when not provided', async () => {
    const { client, fetchMock } = makeClient()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ order: {}, dispute_tx: { xdr: '', networkPassphrase: '' } }),
    })

    await postDispute(client, 'ord_di2', { reason: 'OTHER', note: 'Something else' })

    const [, opts] = fetchMock.mock.calls[0]
    const sentBody = JSON.parse(opts.body)
    expect(sentBody).toEqual({ reason: 'OTHER', note: 'Something else' })
    expect('evidenceUrl' in sentBody).toBe(false)
  })
})
