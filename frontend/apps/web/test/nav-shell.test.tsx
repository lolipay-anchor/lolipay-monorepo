import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUsePathname = vi.fn(() => '/')
const mockPush = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
  useRouter: () => ({ push: mockPush }),
}))

const { NavShell } = await import('@/app/nav-shell')

describe('NavShell', () => {
  beforeEach(() => {
    mockPush.mockClear()
  })

  it('renders all four tabs', () => {
    mockUsePathname.mockReturnValue('/')
    render(<NavShell />)

    expect(screen.getByRole('button', { name: /Home/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Trade/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Orders/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Profile/i })).toBeTruthy()
  })

  it('marks Home as active on "/"', () => {
    mockUsePathname.mockReturnValue('/')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Home/i }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: /Trade/i }).getAttribute('aria-current')).toBeNull()
  })

  it('marks Trade as active on "/buy"', () => {
    mockUsePathname.mockReturnValue('/buy')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Trade/i }).getAttribute('aria-current')).toBe('page')
  })

  it('marks Trade as active on "/sell"', () => {
    mockUsePathname.mockReturnValue('/sell')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Trade/i }).getAttribute('aria-current')).toBe('page')
  })

  it('marks Orders as active on "/orders/abc"', () => {
    mockUsePathname.mockReturnValue('/orders/abc')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Orders/i }).getAttribute('aria-current')).toBe('page')
  })

  it('marks Profile as active on "/profile"', () => {
    mockUsePathname.mockReturnValue('/profile')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Profile/i }).getAttribute('aria-current')).toBe('page')
  })

  it('pushes the right route when a tab is clicked', () => {
    mockUsePathname.mockReturnValue('/')
    render(<NavShell />)
    screen.getByRole('button', { name: /Trade/i }).click()
    expect(mockPush).toHaveBeenCalledWith('/buy')

    screen.getByRole('button', { name: /Orders/i }).click()
    expect(mockPush).toHaveBeenCalledWith('/orders')

    screen.getByRole('button', { name: /Profile/i }).click()
    expect(mockPush).toHaveBeenCalledWith('/profile')

    screen.getByRole('button', { name: /Home/i }).click()
    expect(mockPush).toHaveBeenCalledWith('/')
  })

  it('is fixed to the bottom of the viewport', () => {
    mockUsePathname.mockReturnValue('/')
    render(<NavShell />)
    expect(screen.getByRole('button', { name: /Home/i }).closest('nav')?.className).toContain('fixed')
  })
})
