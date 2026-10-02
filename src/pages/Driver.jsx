// Driver screen. Works with no signal: the route is cached on the phone, every
// action is written to a local queue first, and the queue drains by itself when
// the network comes back. GPS only ever adds a safety check, it is never
// required, and the 20 m rule is relaxed rather than blocking the button.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/index.jsx'
import { useStore, refreshStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { flushQueue, queueRequest, useQueue } from '../lib/queue.js'
import { cacheRoute, cachedRoute, clearSession, getSession, newActionId, setSession } from '../lib/local.js'
import { fmtClock, fmtDateTime, levelOf, metresBetween } from '../lib/format.js'
import { Btn, Choice, LevelChip, Notice, Panel, Row, TextInput } from '../components/ui.jsx'
import MapView from '../components/MapView.jsx'
import {
  Truck, CircleCheck, CircleAlert, TriangleAlert, Plus, Navigation, MapPin, LogOut, RefreshCw, CloudOff, CircleX,
} from 'lucide-react'

function pointsOf(r) {
  return (r?.stops || []).map((s) => ({
    id: s.point_id,
    code: s.code,
    name: s.name,
    landmark: s.landmark,
    lat: s.lat,
    lng: s.lng,
    ward: s.ward,
    estimated_level: s.estimated_level,
  }))
}

const HOLD_SECONDS = 30
const NEAR_METRES = 20

const PROBLEMS = [
  { value: 'bin_missing', key: 'driver.problemBin' },
  { value: 'road_blocked', key: 'driver.problemRoad' },
  { value: 'truck_full', key: 'driver.problemFull' },
  { value: 'breakdown', key: 'driver.problemBreakdown' },
]

function Login({ onDone, t }) {
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [demo, setDemo] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.get('/demo/logins').then((d) => setDemo(d)).catch(() => setDemo(null))
  }, [])

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/login', { role: 'driver', phone, pin })
      if (!res.ok) {
        setError(res.error || t('control.error'))
        return
      }
      setSession({ role: 'driver', driverId: res.driver.id, name: res.driver.name })
      onDone()
    } catch {
      setError(t('common.errorState'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold text-ink-900">{t('driver.login')}</h1>
      <Panel>
        <form onSubmit={submit} className="space-y-3 px-4 py-4">
          <div>
            <label htmlFor="drv-phone" className="block text-sm font-medium text-ink-700">
              {t('driver.phone')}
            </label>
            <TextInput
              id="drv-phone"
              className="mt-1.5"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              required
            />
          </div>
          <div>
            <label htmlFor="drv-pin" className="block text-sm font-medium text-ink-700">
              {t('driver.pin')}
            </label>
            <TextInput
              id="drv-pin"
              className="mt-1.5 cr-num"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={4}
              required
            />
          </div>
          {error ? <Notice tone="red">{error}</Notice> : null}
          <Btn type="submit" variant="primary" size="lg" loading={busy} disabled={!phone || pin.length !== 4}>
            {t('driver.signIn')}
          </Btn>
        </form>
      </Panel>

      {demo?.drivers?.length ? (
        <Panel title={t('driver.demoTitle')} hint={t('driver.demoHint')}>
          <ul className="divide-y divide-line-soft">
            {demo.drivers.map((d) => (
              <li key={d.phone}>
                <button
                  type="button"
                  onClick={() => {
                    setPhone(d.phone)
                    setPin(d.pin)
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#f4f4f4]"
                >
                  <span>
                    <span className="block text-sm font-medium text-ink-900">{d.name}</span>
                    <span className="cr-num block text-[12px] text-ink-500">{t('driver.code')}</span>
                  </span>
                  <span className="cr-num text-sm text-ink-700">
                    {d.phone} / {d.pin}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}

export default function Driver() {
  const { t, lang } = useI18n()
  const { state, online } = useStore()
  const { count } = useQueue()
  const [session, setSessionState] = useState(() => getSession())
  const [route, setRoute] = useState(null)
  const [routeAt, setRouteAt] = useState(null)
  const [active, setActive] = useState(null)
  const [problem, setProblem] = useState(null)
  const [note, setNote] = useState('')
  const [holdLeft, setHoldLeft] = useState(0)
  const [tooFar, setTooFar] = useState(false)
  const [gps, setGps] = useState(null)
  const [flash, setFlash] = useState(null)
  const [newBin, setNewBin] = useState({ lat: '', lng: '', code: '' })
  const [busy, setBusy] = useState(false)
  const holdTimer = useRef(null)

  const stops = route?.stops || []
  const doneCount = stops.filter((s) => s.status === 'done').length

  const loadRoute = useCallback(
    async (driverId, { quiet } = {}) => {
      try {
        const r = await api.get(`/driver/route?driver_id=${encodeURIComponent(driverId)}`)
        setRoute(r)
        setRouteAt(Date.now())
        cacheRoute(driverId, r)
      } catch (err) {
        if (quiet) setRoute(cachedRoute(driverId)?.route || null)
        else setRoute(null)
        return err
      }
      return null
    },
    [],
  )

  useEffect(() => {
    if (!session?.driverId) return
    loadRoute(session.driverId)
  }, [session?.driverId, loadRoute])

  // Keep the stop list fresh while online, and fall back to the phone's copy.
  useEffect(() => {
    if (!session?.driverId || !online) return
    const id = setInterval(() => loadRoute(session.driverId, { quiet: true }), 3000)
    return () => clearInterval(id)
  }, [session?.driverId, online, loadRoute])

  useEffect(() => {
    if (!session?.driverId || online) return
    const cached = cachedRoute(session.driverId)
    if (cached) {
      setRoute(cached.route)
      setRouteAt(cached.at)
    }
  }, [session?.driverId, online])

  useEffect(() => {
    if (online) flushQueue()
  }, [online])

  useEffect(() => () => clearInterval(holdTimer.current), [])

  const activePoint = useMemo(
    () => (active ? pointsOf(route).find((p) => p.id === active.point_id) : null),
    [active, route],
  )

  function act(kind, payload) {
    queueRequest('/action', {
      action_id: newActionId(),
      driver_id: session.driverId,
      kind,
      payload: { ...payload, at: new Date().toISOString() },
    })
    setFlash({ tone: 'amber', text: online ? t('report.sending') : t('driver.offlineQueued') })
    refreshStore()
    loadRoute(session.driverId, { quiet: true })
  }

  function beginEmpty() {
    if (!active) return
    setTooFar(false)
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        () => setGps(null),
        { enableHighAccuracy: true, timeout: 6000 },
      )
    }
    let left = HOLD_SECONDS
    setHoldLeft(left)
    clearInterval(holdTimer.current)
    holdTimer.current = setInterval(() => {
      left -= 1
      setHoldLeft(left)
      if (left <= 0) {
        clearInterval(holdTimer.current)
        setHoldLeft(0)
      }
    }, 1000)
  }

  function confirmEmpty() {
    if (!active || holdLeft > 0) return
    const d = activePoint ? metresBetween(gps, { lat: activePoint.lat, lng: activePoint.lng }) : null
    // No fix, or too far: allow it and say so. Never block the bin.
    setTooFar(!!(gps && d !== null && d > NEAR_METRES))
    act('emptied', { stop_id: active.id, note })
    setFlash({ tone: 'green', text: t('driver.emptiedNote') })
    setActive(null)
    setNote('')
  }

  if (!session?.driverId) return <Login t={t} onDone={() => setSessionState({ ...getSession() })} />

  const next = stops.find((s) => s.status === 'pending')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">{t('driver.today')}</h1>
          <p className="text-sm text-ink-500">{t('driver.loggedInAs', { name: session.name })}</p>
        </div>
        <div className="flex gap-2">
          <Btn size="sm" variant="secondary" onClick={() => loadRoute(session.driverId)}>
            <RefreshCw size={16} aria-hidden />
            {t('driver.refreshRoute')}
          </Btn>
          <Btn
            size="sm"
            variant="quiet"
            onClick={() => {
              clearSession()
              setSessionState(null)
              setRoute(null)
            }}
          >
            <LogOut size={16} aria-hidden />
            {t('nav.signOut')}
          </Btn>
        </div>
      </div>

      {!online ? (
        <Notice tone="amber" icon={CloudOff} title={t('driver.offline')}>
          {routeAt ? t('driver.cacheTime', { time: fmtClock(routeAt, lang) }) : t('nav.loading')}
        </Notice>
      ) : null}

      {count > 0 ? (
        <Notice tone="amber" icon={CircleAlert} title={t('driver.syncWaiting', { n: count })}>
          {online ? t('driver.backOnline') : t('driver.offlineQueued')}
        </Notice>
      ) : null}

      {flash ? (
        <Notice tone={flash.tone} icon={flash.tone === 'green' ? CircleCheck : CircleAlert}>
          {flash.text}
        </Notice>
      ) : null}

      {route?.truck ? (
        <Panel title={route.truck.name}>
          <div className="grid grid-cols-2 gap-4 px-4 py-3 sm:grid-cols-4">
            <Row label={t('driver.km')} value={`${route.stops.length} ${t('control.stops')}`} />
            <Row label={t('control.plate')} value={route.truck.plate} mono />
            <Row label={t('common.status')} value={route.truck.status} />
            <Row label={t('control.capacity')} value={`${route.truck.capacity_kg} kg`} mono />
          </div>
        </Panel>
      ) : null}

      {stops.length === 0 ? (
        <Panel>
          <p className="px-4 py-6 text-sm text-ink-500">{t('driver.noStops')}</p>
        </Panel>
      ) : (
        <>
          <Panel
            title={doneCount === stops.length ? t('driver.stopDone') : t('driver.stop', { n: doneCount + 1, total: stops.length })}
            action={
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-700">
                <Truck size={16} className="text-brand-700" aria-hidden />
                {doneCount}/{stops.length}
              </span>
            }
          >
            <ol className="divide-y divide-line-soft">
              {stops.map((s) => {
                const on = active?.id === s.id
                const done = s.status === 'done'
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActive(on ? null : s)
                        setProblem(null)
                        setNote('')
                        setHoldLeft(0)
                        setTooFar(false)
                      }}
                      aria-pressed={on}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left ${
                        on ? 'bg-brand-50' : done ? 'opacity-60' : 'hover:bg-[#f4f4f4]'
                      }`}
                    >
                      <span
                        className={`cr-num mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[4px] border text-[13px] font-bold ${
                          done ? 'border-brand-200 bg-brand-100 text-brand-800' : 'border-line bg-white text-ink-900'
                        }`}
                      >
                        {done ? <CircleCheck size={16} aria-hidden /> : s.order}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="cr-num text-sm font-semibold text-ink-900">{s.code}</span>
                          <LevelChip level={levelOf(s.estimated_level)} pct={s.estimated_level} t={t} />
                        </span>
                        <span className="mt-0.5 block truncate text-sm text-ink-700">{s.name}</span>
                        <span className="block truncate text-[12px] text-ink-500">
                          {s.landmark || s.ward}
                          {s.action_note ? ` - ${s.action_note}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </Panel>

          {active ? (
            <Panel title={`${t('driver.stop', { n: active.order, total: stops.length })} - ${active.code}`}>
              <div className="space-y-3 px-4 py-4">
                <p className="text-sm text-ink-700">{active.name}</p>
                <LevelChip level={levelOf(active.estimated_level)} pct={active.estimated_level} t={t} />
                <p className="text-[13px] text-ink-500">
                  {t('control.lastEmptied')}: {active.last_emptied_at ? fmtDateTime(active.last_emptied_at, lang) : '-'}
                </p>

                <MapView
                  points={pointsOf(route)}
                  selectedPointId={active.point_id}
                  fit={false}
                  center={[active.lat, active.lng]}
                  zoom={15}
                />

                <div className="flex flex-wrap gap-2">
                  <a
                    className="inline-flex min-h-14 items-center gap-2 rounded-[6px] border border-line bg-white px-4 text-[15px] font-medium"
                    href={`https://www.openstreetmap.org/directions?to=${active.lat},${active.lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <Navigation size={16} aria-hidden />
                    {t('driver.navigate')}
                  </a>
                  <Btn variant="secondary" onClick={() => act('arrive', { stop_id: active.id })}>
                    <MapPin size={16} aria-hidden />
                    {t('driver.nextStop')}
                  </Btn>
                </div>

                {holdLeft > 0 ? (
                  <div>
                    <div className="h-2 w-full overflow-hidden rounded-[3px] border border-line-soft bg-[#f0f0f0]">
                      <div
                        className="h-full bg-brand-700"
                        style={{ width: `${((HOLD_SECONDS - holdLeft) / HOLD_SECONDS) * 100}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[13px] text-ink-700">
                      {t('driver.emptiedWait', { left: holdLeft })}
                    </p>
                    <p className="text-[12px] text-ink-500">{t('driver.emptiedHold')}</p>
                  </div>
                ) : null}

                {!gps && !holdLeft ? <Notice tone="grey">{t('driver.gpsOff')}</Notice> : null}
                {tooFar ? <Notice tone="amber">{t('driver.emptiedHold')}</Notice> : null}

                <div>
                  <label htmlFor="drv-note" className="block text-sm font-medium text-ink-700">
                    {t('driver.reason')}
                  </label>
                  <TextInput
                    id="drv-note"
                    className="mt-1.5"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={t('custodian.notes')}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Btn variant="primary" size="lg" onClick={beginEmpty} disabled={holdLeft > 0}>
                    <Trash size={18} aria-hidden />
                    {t('driver.emptied')}
                  </Btn>
                  <Btn variant="secondary" onClick={confirmEmpty} disabled={holdLeft > 0}>
                    <CircleCheck size={18} aria-hidden />
                    {t('driver.emptiedConfirm')}
                  </Btn>
                  <Btn
                    variant="secondary"
                    onClick={() => {
                      act('nothing_to_collect', { stop_id: active.id })
                      setFlash({ tone: 'green', text: t('driver.nothingNote') })
                      setActive(null)
                    }}
                  >
                    <CircleX size={18} aria-hidden />
                    {t('driver.nothingToCollect')}
                  </Btn>
                  <Btn variant="warn" onClick={() => setProblem(problem ? null : 'open')}>
                    <TriangleAlert size={18} aria-hidden />
                    {t('driver.problem')}
                  </Btn>
                </div>

                {problem === 'open' ? (
                  <div className="space-y-2 rounded-[6px] border border-warn-500 bg-warn-50 p-3">
                    <Choice
                      name={t('driver.problem')}
                      columns={2}
                      value={problem}
                      onChange={(v) => {
                        act('problem', { stop_id: active.id, problem: v })
                        setFlash({
                          tone: 'green',
                          text:
                            v === 'breakdown'
                              ? t('driver.breakdownNote')
                              : v === 'road_blocked'
                                ? t('driver.roadNote')
                                : v === 'truck_full'
                                  ? t('driver.yardNote')
                                  : t('driver.nothingNote'),
                        })
                        setProblem(null)
                        setActive(null)
                      }}
                      options={PROBLEMS.map((p) => ({ value: p.value, label: t(p.key) }))}
                    />
                  </div>
                ) : null}
              </div>
            </Panel>
          ) : next ? (
            <Btn variant="primary" size="lg" onClick={() => setActive(next)}>
              {t('driver.nextStop')}: {next.code}
            </Btn>
          ) : null}

          <Panel title={t('driver.addBin')}>
            <div className="space-y-3 px-4 py-4">
              <p className="text-[13px] text-ink-500">{t('report.pinHint')}</p>
              <AddBinForm
                driverId={session.driverId}
                value={newBin}
                onChange={setNewBin}
                onSent={() => {
                  setFlash({ tone: 'green', text: t('driver.addBinPending') })
                  setNewBin({ lat: '', lng: '', code: '' })
                }}
              />
            </div>
          </Panel>
        </>
      )}

      <Panel title={t('nav.logs')}>
        <ul className="divide-y divide-line-soft">
          {(state?.activity || [])
            .filter((a) => a.kind === 'report' || a.kind === 'route' || a.kind === 'breakdown')
            .slice(0, 8)
            .map((a) => (
              <li key={a.id} className="flex items-baseline justify-between gap-3 px-4 py-2">
                <span className="text-sm text-ink-700">{a.message}</span>
                <span className="cr-num shrink-0 text-[12px] text-ink-500">{fmtClock(a.at, lang)}</span>
              </li>
            ))}
        </ul>
      </Panel>
    </div>
  )
}

function AddBinForm({ driverId, value, onChange, onSent }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post('/action', {
        action_id: newActionId(),
        driver_id: driverId,
        kind: 'add_bin',
        payload: { lat: Number(value.lat), lng: Number(value.lng), code: value.code },
      })
      if (!res.ok) setError(res.error || t('control.error'))
      else onSent()
    } catch {
      queueRequest('/action', {
        action_id: newActionId(),
        driver_id: driverId,
        kind: 'add_bin',
        payload: { lat: Number(value.lat), lng: Number(value.lng), code: value.code },
      })
      onSent()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <TextInput
        value={value.code}
        onChange={(e) => onChange({ ...value, code: e.target.value })}
        placeholder={t('driver.code')}
        aria-label={t('driver.code')}
      />
      <TextInput
        value={value.lat}
        onChange={(e) => onChange({ ...value, lat: e.target.value })}
        placeholder="lat"
        inputMode="decimal"
        aria-label="lat"
      />
      <TextInput
        value={value.lng}
        onChange={(e) => onChange({ ...value, lng: e.target.value })}
        placeholder="lng"
        inputMode="decimal"
        aria-label="lng"
      />
      {error ? <Notice tone="red">{error}</Notice> : null}
      <Btn
        variant="secondary"
        onClick={send}
        loading={busy}
        disabled={!value.lat || !value.lng}
        className="sm:col-span-3"
      >
        <Plus size={16} aria-hidden />
        {t('driver.addBin')}
      </Btn>
    </div>
  )
}