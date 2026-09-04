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

export function activeCountdown(order: {
  status: OrderStatus
  flow: Flow
  pay_deadline: number
  confirm_deadline: number
  expires_at: string
}): { deadline: number; label: string } | null {
  const lpPaysFiat = order.flow !== 'TOP_UP'
  switch (order.status) {
    case 'MATCHED':
    case 'AWAITING_ONCHAIN':

      return { deadline: Math.floor(new Date(order.expires_at).getTime() / 1000), label: 'Lock within' }
    case 'FUNDED':

      return {
        deadline: lpPaysFiat ? order.confirm_deadline : order.pay_deadline,
        label: lpPaysFiat ? 'Merchant pays within' : 'Pay within',
      }
    case 'FIAT_PAID':
      if (lpPaysFiat) return null
      return { deadline: order.confirm_deadline, label: 'Merchant releases within' }
    default:
      return null
  }
}
