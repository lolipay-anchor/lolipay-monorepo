import type { Flow, OrderStatus, UserTier } from '@lolipay/api-client'
import type { PillTone } from '@lolipay/ui'

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function flowLabel(flow: Flow): string {
  if (flow === 'WITHDRAW') return 'Sell'
  return 'Buy'
}

export function pillFor(status: OrderStatus, _flow?: Flow): { tone: PillTone; label: string } {
  if (status === 'RELEASED') return { tone: 'green', label: 'Released' }
  if (status === 'REFUNDED') return { tone: 'amber', label: 'Refunded' }
  if (status === 'EXPIRED') return { tone: 'neutral', label: 'Expired' }
  if (status === 'CANCELLED') return { tone: 'neutral', label: 'Cancelled' }
  if (status === 'DISPUTED') return { tone: 'danger', label: 'Disputed' }
  if (status === 'FIAT_PAID') return { tone: 'amber', label: 'Confirming' }
  if (status === 'FUNDED' || status === 'AWAITING_ONCHAIN') {
    return { tone: 'accent', label: 'In progress' }
  }

  return { tone: 'accent', label: 'Matching' }
}

export function shortAddress(address: string): string {
  return address.slice(0, 4) + '…' + address.slice(-4)
}

const TIER_ORDER: UserTier[] = ['BRONZE', 'SILVER', 'TRUSTED', 'GOLD']

const TIER_THRESHOLDS: Record<Exclude<UserTier, 'BRONZE'>, number> = {
  SILVER: 5,
  TRUSTED: 20,
  GOLD: 50,
}

export function tierLabel(tier: UserTier): string {
  return tier.charAt(0) + tier.slice(1).toLowerCase()
}

export function tierBadgeClasses(tier: UserTier): string {
  switch (tier) {
    case 'GOLD':
      return 'bg-lp-amber-soft text-lp-amber'
    case 'TRUSTED':
      return 'bg-lp-accent-soft text-lp-accent-ink'
    case 'SILVER':
      return 'bg-lp-usdc/10 text-lp-usdc'
    default:
      return 'bg-lp-line-2 text-lp-ink-soft'
  }
}

export function nextTier(tier: UserTier): UserTier | null {
  const i = TIER_ORDER.indexOf(tier)
  return i >= 0 && i < TIER_ORDER.length - 1 ? TIER_ORDER[i + 1] : null
}

export function nextTierThreshold(tier: UserTier): number | null {
  const next = nextTier(tier)
  return next ? TIER_THRESHOLDS[next as Exclude<UserTier, 'BRONZE'>] : null
}

export function formatUsdcAmount(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
