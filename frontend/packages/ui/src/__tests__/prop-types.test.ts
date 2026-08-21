import { describe, it, expect } from 'vitest'
import type { HoldToReleaseProps } from '../HoldToRelease'
import type { BottomNavProps, BottomNavItem } from '../BottomNav'
import type { StatusPillProps } from '../StatusPill'
import type { StatCardProps } from '../StatCard'
import type { ActionTileProps } from '../ActionTile'
import type { DarkHeroCardProps } from '../DarkHeroCard'
import type { SegmentProgressProps } from '../SegmentProgress'
import type { CountdownProps } from '../Countdown'
import type { NotificationBellProps } from '../NotificationBell'
import type { ButtonVariant } from '../Button'

describe('exported prop types', () => {
  it('HoldToReleaseProps has the expected shape', () => {
    const props: HoldToReleaseProps = { onComplete: () => {} }
    expect(props.onComplete).toBeInstanceOf(Function)
  })

  it('BottomNavProps has the expected shape', () => {
    const items: BottomNavItem[] = [{ key: 'home', label: 'Home', icon: null }]
    const props: BottomNavProps = { items, active: 'home', onSelect: () => {} }
    expect(props.items).toBe(items)
  })

  it('StatusPillProps has the expected shape', () => {
    const props: StatusPillProps = { tone: 'green', children: 'ok' }
    expect(props.tone).toBe('green')
  })

  it('StatCardProps has the expected shape', () => {
    const props: StatCardProps = { label: 'Balance', value: '100' }
    expect(props.label).toBe('Balance')
  })

  it('ActionTileProps has the expected shape', () => {
    const props: ActionTileProps = { icon: null, label: 'Top up' }
    expect(props.label).toBe('Top up')
  })

  it('DarkHeroCardProps has the expected shape', () => {
    const props: DarkHeroCardProps = { children: 'hero' }
    expect(props.children).toBe('hero')
  })

  it('SegmentProgressProps has the expected shape', () => {
    const props: SegmentProgressProps = { done: 2 }
    expect(props.done).toBe(2)
  })

  it('CountdownProps has the expected shape', () => {
    const props: CountdownProps = { deadline: Date.now() }
    expect(props.deadline).toBeTypeOf('number')
  })

  it('NotificationBellProps has the expected shape', () => {
    const props: NotificationBellProps = { unread: 3 }
    expect(props.unread).toBe(3)
  })

  it('ButtonVariant includes outline alongside primary/ghost', () => {
    const variants: ButtonVariant[] = ['primary', 'ghost', 'outline']
    expect(variants).toContain('outline')
  })
})
