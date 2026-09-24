import type { OrderStatus, Flow } from '@lolipay/api-client'

export type StepState = 'done' | 'now' | 'pending'

export interface Step {
  label: string
  state: StepState
}

const LABELS_TOP_UP = [
  'Order created',
  'Merchant locks USDC',
  'Pay the merchant',
  'USDC released to you',
] as const

const LABELS_WITHDRAW = [
  'Order created',
  'You lock USDC',
  'Merchant pays your bank',
  'USDC released to merchant',
] as const

export function isTerminal(status: OrderStatus): boolean {
  return (
    status === 'RELEASED' ||
    status === 'CANCELLED' ||
    status === 'EXPIRED' ||
    status === 'REFUNDED' ||
    status === 'DISPUTED'
  )
}

export function stepsFor(status: OrderStatus, flow: Flow = 'TOP_UP'): Step[] {
  const LABELS = flow === 'WITHDRAW' ? LABELS_WITHDRAW : LABELS_TOP_UP

  if (
    status === 'CANCELLED' ||
    status === 'EXPIRED' ||
    status === 'REFUNDED' ||
    status === 'DISPUTED'
  ) {
    return LABELS.map((label, i) => ({
      label,
      state: i === 0 ? 'done' : 'pending',
    }))
  }

  let activeStep: number
  switch (status) {
    case 'CREATED':
    case 'MATCHED':
    case 'AWAITING_ONCHAIN':
      activeStep = 1
      break
    case 'FUNDED':
      activeStep = 2
      break
    case 'FIAT_PAID':
      activeStep = 3
      break
    case 'RELEASED':

      activeStep = 4
      break
    default:
      activeStep = 1
  }

  return LABELS.map((label, i) => {
    let state: StepState
    if (i < activeStep) {
      state = 'done'
    } else if (i === activeStep) {
      state = 'now'
    } else {
      state = 'pending'
    }
    return { label, state }
  })
}

export type ActiveCountdown =
  | { deadline: number; label: string; expired?: false }
  | { label: string; expired: true }

type Window = { deadline: number; label: string; pastLabel: string | null }

function windowFor(
  order: {
    status: OrderStatus
    flow: Flow
    pay_deadline: number
    confirm_deadline: number
    refund_opens_at: number
    expires_at: string
    sign_by?: number
  },
  now: number,
): Window | null {
  const lpPaysFiat = order.flow !== 'TOP_UP'
  switch (order.status) {
    case 'MATCHED':
    case 'AWAITING_ONCHAIN':
      return {
        deadline: order.sign_by ?? Math.floor(new Date(order.expires_at).getTime() / 1000),
        label: 'Lock within',
        pastLabel: null,
      }
    case 'FUNDED':
      if (lpPaysFiat) {
        return {
          deadline: order.refund_opens_at + 1,
          label: 'Merchant pays within',
          pastLabel: "Merchant's time is up",
        }
      }
      if (now < order.pay_deadline) {
        return { deadline: order.pay_deadline, label: 'Pay within', pastLabel: null }
      }
      return {
        deadline: order.refund_opens_at + 1,
        label: 'Can still be confirmed for',
        pastLabel: null,
      }
    default:
      return null
  }
}

export function activeCountdown(order: {
  status: OrderStatus
  flow: Flow
  pay_deadline: number
  confirm_deadline: number
  refund_opens_at: number
  expires_at: string
  sign_by?: number
}): ActiveCountdown | null {
  const now = Math.floor(Date.now() / 1000)
  const w = windowFor(order, now)
  if (w === null) return null
  if (now < w.deadline) return { deadline: w.deadline, label: w.label }
  if (w.pastLabel === null) return null
  return { label: w.pastLabel, expired: true }
}
