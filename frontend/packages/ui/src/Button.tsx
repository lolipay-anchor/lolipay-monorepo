import * as React from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'danger'

export function Button({
  variant = 'primary',
  size = 'default',
  loading = false,
  disabled,
  className = '',
  children,
  ...rest
}: {
  variant?: ButtonVariant
  size?: 'default' | 'sm'
  loading?: boolean
  className?: string
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'size'>) {
  const base =
    size === 'sm'
      ? 'rounded-lp-cta py-1.5 px-4 font-semibold text-sm transition'
      : 'w-full rounded-lp-cta py-3.5 font-semibold text-[15px] transition'
  const styles =
    variant === 'primary'
      ? 'bg-lp-accent text-white shadow-lp-cta hover:bg-lp-accent-ink disabled:opacity-50'
      : variant === 'danger'
        ? 'bg-lp-danger text-white shadow-lp-cta hover:opacity-90 disabled:opacity-50'
        : variant === 'outline'
          ? 'border border-lp-line bg-lp-surface text-lp-ink disabled:opacity-50'
          : 'text-lp-ink-soft disabled:opacity-50'
  return (
    <button
      className={[base, styles, className].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? (
        <span aria-label="loading" className="inline-block animate-spin">
          ◌
        </span>
      ) : (
        children
      )}
    </button>
  )
}
