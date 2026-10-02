// Control room, first screen: every collection point on an OpenStreetMap
// leaflet map, coloured by estimated level, with the same points in a list
// ordered the way a dispatcher works through them.

import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/index.jsx'
import { useStore } from '../lib/store.js'
import { fmtAgo, fmtClock, fmtNum } from '../lib/format.js'
import { Empty, Panel } from '../components/ui.jsx'
import MapView from '../components/MapView.jsx'

/**
 * Three bands, so the map stays readable at a glance. The cut points match the
 * words a citizen can report: under 45% is low, 45 to 85 is filling up, 85 and
 * above needs a truck now.
 */
const BANDS = [
  { id: 'green', to: 45, colour: '#15803d', key: 'control.band.low' },
  { id: 'amber', to: 85, colour: '#f59e0b', key: 'control.band.mid' },
  { id: 'red', to: Infinity, colour: '#dc2626', key: 'control.band.high' },
]

const bandOf = (pct) => BANDS.find((b) => (Number(pct) || 0) < b.to) || BANDS[BANDS.length - 1]

// Declared once, so the map does not redraw itself on every render.
const colourFor = (p) => bandOf(p.estimated_level).colour

/**
 * Dispatch order. Priority is the server's own score from buildCandidates, the
 * same number the router uses to pick stops, so this list and the generated
 * routes agree. Level and then code only break ties, which keeps the list from
 * shuffling between two polls carrying the same numbers.
 */
function byPriority(a, b, priorityById) {
  const pa = priorityById.get(a.id)?.priority ?? 0
  const pb = priorityById.get(b.id)?.priority ?? 0
  if (pa !== pb) return pb - pa
  const la = Number(a.estimated_level) || 0
  const lb = Number(b.estimated_level) || 0
  if (la !== lb) return lb - la
  return a.code.localeCompare(b.code)
}

function Swatch({ colour }) {
  return (
    <span
      aria-hidden
      className="h-3 w-3 shrink-0 rounded-full border border-line-soft"
      style={{ background: colour }}
    />
  )
}

/** Colour never carries the meaning alone: every band shows a word and a count. */
function Legend({ counts, t }) {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line-soft px-4 py-3 text-[13px] text-ink-700">
      {BANDS.map((b) => (
        <li key={b.id} className="flex items-center gap-1.5">
          <Swatch colour={b.colour} />
          <span>{t(b.key)}</span>
          <span className="cr-num font-semibold text-ink-900">{fmtNum(counts[b.id])}</span>
        </li>
      ))}
    </ul>
  )
}

export default function Control() {
  const { t, lang } = useI18n()
  const { state, error } = useStore()
  const [selectedId, setSelectedId] = useState(null)
  const [fitted, setFitted] = useState(false)

  // Server time, not the browser clock, so the list and the map agree.
  const now = state ? new Date(state.serverTime).getTime() : Date.now()

  const points = useMemo(() => (state?.points || []).filter((p) => p.status === 'active'), [state])

  const priorityById = useMemo(() => {
    const m = new Map()
    for (const r of state?.predictions || []) m.set(r.point_id, r)
    return m
  }, [state])

  const ordered = useMemo(() => [...points].sort((a, b) => byPriority(a, b, priorityById)), [points, priorityById])

  const counts = useMemo(() => {
    const c = { green: 0, amber: 0, red: 0 }
    for (const p of points) c[bandOf(p.estimated_level).id] += 1
    return c
  }, [points])

  // Fit the first set of points once. After that the operator keeps the view
  // they moved to, instead of having it pulled back on every data change.
  useEffect(() => {
    if (points.length && !fitted) setFitted(true)
  }, [points.length, fitted])

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_336px] lg:items-start">
      <Panel
        title={t('control.liveMap')}
        hint={
          state
            ? t('common.lastUpdated', { time: fmtClock(state.serverTime, lang) })
            : t('nav.loading')
        }
      >
        <MapView
          points={points}
          graph={state?.graph}
          places={state?.places}
          blockedRoads={state?.blockedRoads}
          selectedPointId={selectedId}
          onPointClick={(p) => setSelectedId(p.id === selectedId ? null : p.id)}
          colourFor={colourFor}
          fit={!fitted}
          className="border-0! sm:h-[380px] lg:h-[540px]"
        />
        <Legend counts={counts} t={t} />
      </Panel>

      <Panel title={t('control.points')} hint={t('control.priority')}>
        {ordered.length === 0 ? (
          <Empty>{error ? t('common.errorState') : t('nav.loading')}</Empty>
        ) : (
          <ol className="max-h-[380px] divide-y divide-line-soft overflow-y-auto lg:max-h-[500px]">
            {ordered.map((p, i) => {
              const on = p.id === selectedId
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(on ? null : p.id)}
                    aria-pressed={on}
                    className={`flex w-full items-start gap-3 px-4 py-3 text-left ${
                      on ? 'bg-brand-50' : 'hover:bg-[#f4f4f4]'
                    }`}
                  >
                    <span className="cr-num w-6 shrink-0 pt-0.5 text-[13px] font-semibold text-ink-400">
                      {i + 1}
                    </span>
                    <span className="pt-1">
                      <Swatch colour={colourFor(p)} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="cr-num text-[13px] font-semibold text-ink-700">{p.code}</span>
                        <span className="cr-num text-[13px] font-semibold text-ink-900">
                          {Math.round(p.estimated_level)}%
                        </span>
                      </span>
                      <span className="block truncate text-[15px] text-ink-900">{p.name}</span>
                      <span className="mt-0.5 block text-[12px] text-ink-500">
                        {p.ward} · {t('control.lastEmptied')} {fmtAgo(p.last_emptied_at, lang, now)}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
        {state?.counts.pending ? (
          <p className="border-t border-line-soft px-4 py-2.5 text-[13px] text-ink-500">
            {t('control.pendingBins')}:{' '}
            <span className="cr-num font-semibold text-ink-700">{fmtNum(state.counts.pending)}</span>
          </p>
        ) : null}
      </Panel>
    </div>
  )
}
