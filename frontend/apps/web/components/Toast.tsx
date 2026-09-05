'use client'

import * as React from 'react'

type ToastType = 'info' | 'success' | 'error'
interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const ToastCtx = React.createContext<(message: string, type?: ToastType) => void>(() => {})

export const useToast = () => React.useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)

  const toast = React.useCallback((message: string, type: ToastType = 'info') => {
    const id = (idRef.current += 1)
    setToasts((t) => [...t, { id, message, type }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed top-3 inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              role={t.type === 'error' ? 'alert' : 'status'}
              className={
                'pointer-events-auto w-full max-w-sm rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-lg ' +
                (t.type === 'error'
                  ? 'bg-lp-danger'
                  : t.type === 'success'
                    ? 'bg-lp-green'
                    : 'bg-lp-ink')
              }
            >
              {t.message}
            </div>
          ))}
        </div>
      )}
    </ToastCtx.Provider>
  )
}
