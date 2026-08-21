import * as React from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export interface BottomSheetProps {
  open: boolean
  onClose: () => void
  children: React.ReactNode

  ariaLabel?: string

  ariaLabelledBy?: string

  dismissible?: boolean
}

export function BottomSheet({
  open,
  onClose,
  children,
  ariaLabel,
  ariaLabelledBy,
  dismissible = true,
}: BottomSheetProps) {
  const sheetRef = React.useRef<HTMLDivElement>(null)
  const previouslyFocused = React.useRef<HTMLElement | null>(null)

  const onCloseRef = React.useRef(onClose)
  React.useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  const dismissibleRef = React.useRef(dismissible)
  React.useEffect(() => {
    dismissibleRef.current = dismissible
  }, [dismissible])

  React.useEffect(() => {
    if (!open) return

    previouslyFocused.current = document.activeElement as HTMLElement | null

    const focusables = sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    const first = focusables && focusables.length > 0 ? focusables[0] : sheetRef.current
    first?.focus()

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (dismissibleRef.current) onCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        const nodes = sheetRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        if (!nodes || nodes.length === 0) {
          e.preventDefault()
          return
        }
        const list = Array.from(nodes)
        const firstEl = list[0]
        const lastEl = list[list.length - 1]
        const active = document.activeElement

        if (e.shiftKey) {
          if (active === firstEl || !sheetRef.current?.contains(active)) {
            e.preventDefault()
            lastEl.focus()
          }
        } else if (active === lastEl || !sheetRef.current?.contains(active)) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-lp-ink/40" onClick={dismissible ? onClose : undefined} />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        tabIndex={-1}
        className="relative w-full bg-lp-paper rounded-t-[20px] p-4 shadow-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="mx-auto mb-3 w-10 h-1 rounded-full bg-lp-line" />
        {children}
      </div>
    </div>
  )
}
