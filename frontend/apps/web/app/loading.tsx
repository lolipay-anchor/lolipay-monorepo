import { NAV_CLEARANCE_CLASS } from '@lolipay/ui'

export default function Loading() {
  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper px-4 pt-4 animate-pulse ${NAV_CLEARANCE_CLASS}`}>
      {}
      <div className="flex items-center justify-between mb-4">
        <div className="h-7 w-24 rounded-md bg-lp-line-2" />
        <div className="h-7 w-28 rounded-full bg-lp-line-2" />
      </div>
      {}
      <div className="h-32 rounded-lp-card bg-lp-raise mb-4" />
      {}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="h-20 rounded-lp-card bg-lp-raise" />
        <div className="h-20 rounded-lp-card bg-lp-raise" />
        <div className="h-20 rounded-lp-card bg-lp-raise" />
      </div>
    </div>
  )
}
