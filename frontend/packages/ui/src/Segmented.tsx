import * as React from 'react'
export function Segmented({ options, value, onChange }:
  { options: string[]; value: string; onChange: (v: string) => void }) {
  return <div className="flex bg-lp-line-2 rounded-[12px] p-1 text-[13px] font-semibold">
    {options.map(o => (
      <button key={o} onClick={() => onChange(o)}
        className={`flex-1 py-2 rounded-[9px] ${o===value?'bg-lp-surface text-lp-accent-ink shadow':'text-lp-muted'}`}>
        {o}</button>))}
  </div>
}
