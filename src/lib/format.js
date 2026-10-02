// Shared display rules. Colour and wording live here so a bin looks the same on
// the citizen screen, the driver screen and the control room map.

export const LEVELS = ['empty', 'half', 'full', 'overflowing']

export const LEVEL_STYLE = {
  empty: { bar: '#737373', chipBg: '#e5e5e5', chipText: '#333333', key: 'report.empty' },
  half: { bar: '#f59e0b', chipBg: '#fef3c7', chipText: '#92400e', key: 'report.half' },
  full: { bar: '#b45309', chipBg: '#ffedd5', chipText: '#7c2d12', key: 'report.full' },
  overflowing: { bar: '#dc2626', chipBg: '#fee2e2', chipText: '#991b1b', key: 'report.overflowing' },
}

/** Estimated percentage to one of the four words a person would use. */
export function levelOf(pct) {
  const p = Number(pct) || 0
  if (p >= 100) return 'full'
  if (p >= 45) return 'half'
  return 'empty'
}

export const LOCALES = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' }
export const localeFor = (lang) => LOCALES[lang] || 'en-IN'

export function fmtNum(n, digits = 0) {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return v.toLocaleString(localeFor(), { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

export const fmtKm = (km) => fmtNum(km, 1)
export const fmtPct = (v) => `${Math.round(Number(v) || 0)}%`
export const fmtRupees = (v) => `₹${fmtNum(v)}`

export function fmtClock(value, lang = 'en') {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleTimeString(localeFor(lang), { hour: '2-digit', minute: '2-digit' })
}

export function fmtDateTime(value, lang = 'en') {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return `${d.toLocaleDateString(localeFor(lang), { day: '2-digit', month: 'short' })} ${fmtClock(d, lang)}`
}

/** "12 min ago" style, used for last report and last emptied. */
export function fmtAgo(value, lang = 'en', now = Date.now()) {
  if (!value) return '-'
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return '-'
  const mins = Math.max(0, Math.round((now - then) / 60000))
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  return `${days} d`
}

export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0))
  const h = Math.floor(m / 60)
  return h ? `${h} h ${m % 60} min` : `${m} min`
}

/** Base map view. Hyderabad, tight enough to fill a phone screen. */
export const MAP_CENTER = [17.419, 78.44]
export const MAP_ZOOM = 12

/** Great-circle metres, used for the 20 m empty-confirmation check. */
export function metresBetween(a, b) {
  if (!a || !b) return null
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}