// Flat municipal design system. No gradients, no shadows, no rounded pills
// everywhere: white panels with a 1px border and a 6px radius, one deep green,
// and grey/amber/red reserved for fill level.

import { useEffect, useId, useRef } from 'react'
import { X, Loader } from 'lucide-react'
import { LEVEL_STYLE } from '../lib/format.js'

export const btnBase =
  'inline-flex items-center justify-center gap-2 rounded-[6px] border font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-55 select-none'

export const btnVariants = {
  primary: 'border-brand-700 bg-brand-700 text-white hover:bg-brand-800',
  secondary: 'border-line bg-white text-ink-900 hover:bg-[#f0f0f0]',
  quiet: 'border-transparent bg-transparent text-ink-700 hover:bg-[#ebebeb]',
  danger: 'border-crit-700 bg-crit-700 text-white hover:bg-[#991b1b]',
  warn: 'border-warn-700 bg-warn-500 text-[#3b2503] hover:bg-[#d98a06]',
}

export const btnSizes = {
  sm: 'px-3 py-2 text-sm',
  md: 'px-4 py-3 text-[15px]',
  lg: 'px-5 py-4 text-base w-full sm:w-auto',
}

export function Btn({ variant = 'secondary', size = 'md', className = '', loading, children, ...rest }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={`${btnBase} ${btnVariants[variant]} ${btnSizes[size]} ${className}`}
    >
      {loading ? <Loader size={18} className="animate-spin" aria-hidden /> : null}
      {children}
    </button>
  )
}

export function Panel({ title, hint, action, children, className = '', as: Tag = 'section' }) {
  return (
    <Tag className={`rounded-[6px] border border-line bg-white ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
            {hint ? <p className="mt-0.5 text-[13px] text-ink-500">{hint}</p> : null}
          </div>
          {action}
        </header>
      )}
      {children}
    </Tag>
  )
}

export function Field({ label, hint, error, children, htmlFor, className = '' }) {
  return (
    <div className={className}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-700">
        {label}
      </label>
      {hint ? <p className="mt-0.5 text-[13px] text-ink-500">{hint}</p> : null}
      <div className="mt-1.5">{children}</div>
      {error ? <p className="mt-1 text-[13px] font-medium text-crit-700">{error}</p> : null}
    </div>
  )
}

const inputBase =
  'w-full rounded-[6px] border border-line bg-white px-3 py-3 text-[15px] text-ink-900 ' +
  'placeholder:text-ink-400 disabled:bg-[#f4f4f4] disabled:text-ink-500'

export function TextInput({ className = '', ...rest }) {
  return <input {...rest} className={`${inputBase} ${className}`} />
}

export function TextArea({ className = '', ...rest }) {
  return <textarea {...rest} className={`${inputBase} min-h-20 ${className}`} />
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select {...rest} className={`${inputBase} pr-8 ${className}`}>
      {children}
    </select>
  )
}

export function Badge({ tone = 'grey', children, className = '' }) {
  const tones = {
    grey: 'bg-[#e5e5e5] text-[#333333]',
    green: 'bg-brand-100 text-brand-800',
    amber: 'bg-warn-50 text-warn-700',
    red: 'bg-crit-50 text-crit-700',
    line: 'border border-line bg-white text-ink-700',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[4px] px-2 py-0.5 text-[12px] font-semibold ${tones[tone] || tones.grey} ${className}`}
    >
      {children}
    </span>
  )
}

/** Fill level as a word plus a number. Colour never carries the meaning alone. */
export function LevelChip({ level, pct, t }) {
  const style = LEVEL_STYLE[level] || LEVEL_STYLE.empty
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[4px] px-2 py-0.5 text-[12px] font-semibold"
      style={{ background: style.chipBg, color: style.chipText }}
    >
      <span className="cr-sr">fill </span>
      {t(style.key)}
      {pct !== undefined && pct !== null ? <span className="cr-num">({Math.round(pct)}%)</span> : null}
    </span>
  )
}

/** Fill level as a bar. Always paired with a word by its caller. */
export function LevelBar({ pct, className = '' }) {
  const p = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)))
  const level = p >= 100 ? 'full' : p >= 45 ? 'half' : 'empty'
  return (
    <div className={`h-2 w-full overflow-hidden rounded-[3px] border border-line-soft bg-[#f0f0f0] ${className}`}>
      <div className="h-full" style={{ width: `${p}%`, background: LEVEL_STYLE[level].bar }} />
    </div>
  )
}

/** Large single-choice control. Used for the four fill words. */
export function Choice({ options, value, onChange, columns = 2, name }) {
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {options.map((o) => {
        const on = o.value === value
        const style = LEVEL_STYLE[o.value] || LEVEL_STYLE.empty
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={`flex min-h-14 items-center gap-2 rounded-[6px] border px-3 py-3 text-left text-[15px] font-medium ${
              on ? 'border-ink-900 bg-white' : 'border-line bg-white hover:bg-[#f4f4f4]'
            }`}
          >
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 rounded-[3px] border border-[#525252]"
              style={{ background: on ? style.bar : '#ffffff' }}
            />
            <span className={on ? 'text-ink-900' : 'text-ink-700'}>{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}

export function Stat({ label, value, unit, tone = 'default' }) {
  const tones = {
    default: 'text-ink-900',
    green: 'text-brand-700',
    amber: 'text-warn-700',
    red: 'text-crit-700',
  }
  return (
    <div className="min-w-0">
      <div className="truncate text-[12px] font-medium uppercase tracking-wide text-ink-500">{label}</div>
      <div className={`cr-num text-xl font-semibold ${tones[tone] || tones.default}`}>
        {value}
        {unit ? <span className="ml-1 text-sm font-medium text-ink-500">{unit}</span> : null}
      </div>
    </div>
  )
}

export function Empty({ children, icon: Icon }) {
  return (
    <p className="flex items-center gap-2 px-4 py-6 text-center text-sm text-ink-500">
      {Icon ? <Icon size={16} aria-hidden className="shrink-0" /> : null}
      <span>{children}</span>
    </p>
  )
}

export function Notice({ tone = 'grey', title, children, icon: Icon, className = '' }) {
  const tones = {
    grey: 'border-line bg-[#f4f4f4] text-ink-700',
    green: 'border-brand-200 bg-brand-50 text-brand-800',
    amber: 'border-warn-500 bg-warn-50 text-warn-700',
    red: 'border-crit-500 bg-crit-50 text-crit-700',
  }
  return (
    <div className={`rounded-[6px] border px-3 py-2.5 text-sm ${tones[tone]} ${className}`}>
      {title ? (
        <p className="flex items-center gap-2 font-semibold">
          {Icon ? <Icon size={16} aria-hidden className="shrink-0" /> : null}
          {title}
        </p>
      ) : null}
      {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
    </div>
  )
}

/** Bottom sheet on phones, centred dialog on wide screens. */
export function Modal({ title, onClose, children, wide, footer }) {
  const ref = useRef(null)
  const titleId = useId()

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    document.addEventListener('keydown', onKey)
    ref.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[1200] flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-4">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-[6px] border border-line bg-white sm:rounded-[6px] ${
          wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'
        }`}
      >
        <header className="sticky top-0 flex items-center justify-between gap-3 border-b border-line-soft bg-white px-4 py-3">
          <h2 id={titleId} className="text-[15px] font-semibold text-ink-900">
            {title}
          </h2>
          <Btn variant="quiet" size="sm" onClick={onClose} aria-label="close">
            <X size={18} aria-hidden />
          </Btn>
        </header>
        <div className="px-4 py-4">{children}</div>
        {footer ? <footer className="sticky bottom-0 border-t border-line-soft bg-white px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={`flex gap-1 overflow-x-auto border-b border-line ${className}`} role="tablist">
      {tabs.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-sm font-medium ${
              on ? 'border-brand-700 text-brand-800' : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function Row({ label, value, mono, className = '' }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-1.5 ${className}`}>
      <span className="text-sm text-ink-500">{label}</span>
      <span className={`text-sm font-medium text-ink-900 ${mono ? 'cr-num' : ''}`}>{value}</span>
    </div>
  )
}

export function Divider({ className = '' }) {
  return <hr className={`my-3 border-0 border-t border-line-soft ${className}`} />
}