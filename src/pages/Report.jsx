// Citizen screen: report a bin as full. No login, no app install, no GPS and no
// photo required. Everything a person can do here is reachable with four big
// buttons and a map tap.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n/index.jsx'
import { useStore, refreshStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { navigate } from '../lib/router.js'
import { useQueue, queueRequest } from '../lib/queue.js'
import { deviceId, forgetBin, savedBins, saveBin } from '../lib/local.js'
import { fmtAgo, fmtDateTime, levelOf, metresBetween } from '../lib/format.js'
import { Btn, LevelBar, LevelChip, Notice, Panel, Row, TextInput } from '../components/ui.jsx'
import MapView from '../components/MapView.jsx'
import {
  Search, MapPin, Crosshair, Camera, Mic, MicOff, Send, CircleCheck, CircleAlert, X, Truck,
} from 'lucide-react'

const LEVEL_WORDS = ['empty', 'half', 'full', 'overflowing']

/** Words the voice listener understands, in all three languages. */
const VOICE_WORDS = {
  empty: ['empty', 'khaali', 'khali', 'ఖాళీ', 'खाली'],
  half: ['half', 'adha', 'అర్ధం', 'आधा'],
  full: ['full', 'bhar', 'poora', 'poora bhara', 'నిండిపోయింది', 'भरा'],
  overflowing: ['overflow', 'overflowing', 'bahut', 'బాగా నిండిపోయింది', 'बहुत'],
}

function matchLevel(text) {
  const s = String(text || '').toLowerCase()
  if (!s) return null
  for (const level of LEVEL_WORDS) {
    if (VOICE_WORDS[level].some((w) => s.includes(w))) return level
  }
  return null
}

/** Downscale in the browser so a photo costs a few KB, not a few MB. */
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read failed'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('decode failed'))
      img.onload = () => {
        const max = 900
        const scale = Math.min(1, max / Math.max(img.width, img.height))
        const w = Math.round(img.width * scale)
        const h = Math.round(img.height * scale)
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d').drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

function nearestPoint(points, lat, lng) {
  let best = null
  let bestM = Infinity
  for (const p of points) {
    const d = metresBetween({ lat, lng }, p)
    if (d < bestM) {
      bestM = d
      best = p
    }
  }
  return { point: best, metres: bestM }
}

export default function Report() {
  const { t, lang } = useI18n()
  const store = useStore()
  const state = store.state
  const online = store.online
  const serverTime = store.state?.serverTime
  const storeVersion = store.state?.version
  const storeUpdatedAt = store.updatedAt
  const { count } = useQueue()

  const me = useMemo(() => deviceId(), [])
  const [bins, setBins] = useState([])
  const [notices, setNotices] = useState([])
  const [selected, setSelected] = useState(null)
  const [level, setLevel] = useState(null)
  const [photo, setPhoto] = useState(null)
  const [pin, setPin] = useState(null)
  const [query, setQuery] = useState('')
  const [code, setCode] = useState('')
  const [results, setResults] = useState([])
  const [busy, setBusy] = useState(false)
  const [locating, setLocating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const [saveIt, setSaveIt] = useState(true)
  const photoInput = useRef(null)
  const recognition = useRef(null)

  const points = state?.points || []

  const loadContext = useCallback(async () => {
    try {
      const ctx = await api.get(`/report/context?device_id=${encodeURIComponent(me)}&saved=${encodeURIComponent(JSON.stringify(savedBins()))}`)
      setBins(ctx.saved || [])
      setNotices(ctx.notices || [])
    } catch {
      setBins([])
      setNotices([])
    }
  }, [me])

  useEffect(() => {
    api.post('/device', { device_id: me }).catch(() => {})
    loadContext()
  }, [me, loadContext])

  useEffect(() => () => recognition.current?.abort?.(), [])

  async function search(text) {
    const q = String(text ?? query).trim()
    setQuery(q)
    if (!q) {
      setResults([])
      return
    }
    try {
      const res = await api.get(`/search?q=${encodeURIComponent(q)}`)
      setResults(res.results || [])
    } catch {
      setResults([])
    }
  }

  function pickPoint(p, source = 'search') {
    setSelected({ point: p, source })
    setLevel(null)
    setPhoto(null)
    setPin(null)
    setResult(null)
    setError(null)
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setError(t('report.locationDenied'))
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        const here = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        const near = nearestPoint(points, here.lat, here.lng)
        if (near.point && near.metres <= 60) {
          pickPoint(near.point, 'gps')
        } else {
          setPin(here)
          setError(null)
        }
      },
      () => {
        setLocating(false)
        setError(t('report.locationDenied'))
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
    )
  }

  function toggleVoice() {
    if (listening) {
      recognition.current?.stop?.()
      setListening(false)
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setError(t('report.voiceUnsupported'))
      return
    }
    const rec = new SR()
    rec.lang = lang === 'hi' ? 'hi-IN' : lang === 'te' ? 'te-IN' : 'en-IN'
    rec.interimResults = true
    rec.maxAlternatives = 3
    rec.onresult = (e) => {
      let text = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        for (let j = 0; j < e.results[i].length; j++) text += `${e.results[i][j].transcript} `
      }
      setHeard(text.trim())
      const hit = matchLevel(text)
      if (hit) {
        setLevel(hit)
        rec.stop()
      }
    }
    rec.onerror = () => {
      setListening(false)
      setError(t('report.voiceNoMatch'))
    }
    rec.onend = () => setListening(false)
    recognition.current = rec
    rec.start()
    setListening(true)
  }

  async function onPhoto(file) {
    if (!file) return
    try {
      setPhoto(await shrinkPhoto(file))
    } catch {
      setError(t('control.error'))
    }
  }

  async function submit() {
    if (!selected || !level) return
    setBusy(true)
    setError(null)
    const body = {
      device_id: me,
      point_id: selected.point.id,
      level,
      source: selected.source,
      lat: selected.point.lat,
      lng: selected.point.lng,
      photo: photo || undefined,
    }
    try {
      const res = await api.post('/report', body)
      if (res.duplicate) {
        setResult({ tone: 'amber', text: t('report.alreadyReported') })
      } else if (res.pending) {
        setResult({ tone: 'amber', text: t('report.pendingApproval') })
      } else {
        setResult({
          tone: 'green',
          text: t('report.thanks'),
          estimated: res.estimated,
          code: res.point?.code,
          pointId: selected.point.id,
        })
        if (saveIt && selected.point.id) saveBin(selected.point.id)
      }
      await refreshStore()
      await loadContext()
    } catch (err) {
      // No signal is the normal case here, so the report waits on the phone.
      if (!online || err.name === 'TypeError') {
        queueRequest('/report', body, level)
        setResult({ tone: 'amber', text: t('driver.offlineQueued') })
        setBins(savedBins())
      } else {
        setError(String(err.message || err))
      }
    } finally {
      setBusy(false)
    }
  }

  function confirmPin() {
    if (!pin) return
    const near = nearestPoint(points, pin.lat, pin.lng)
    if (near.point && near.metres <= 60) {
      pickPoint(near.point, 'pin')
      return
    }
    // Not a known bin. The server creates it as pending and the operator decides.
    setSelected({ point: { id: null, lat: pin.lat, lng: pin.lng, code: t('report.pin'), name: t('report.pin'), ward: '' }, source: 'pin' })
    setLevel(null)
    setResult(null)
  }

  const result2 = result
  const canSend = !!selected && !!level

  const [mountedAt] = useState(() => Date.now())
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [])

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-ink-900">{t('report.title')}</h1>

      {count > 0 ? (
        <Notice tone="amber" icon={CircleAlert} title={t('driver.syncWaiting', { n: count })}>
          {t('driver.offlineQueued')}
        </Notice>
      ) : null}

      {/* ------------------------------------------------------ saved bins */}
      <Panel title={t('report.myBins')}>
        {bins.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-500">{t('report.myBinsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {bins.map((b) => {
              const on = selected?.point?.id === b.id
              return (
                <li key={b.id}>
                  <div className={`flex items-start gap-2 px-4 py-3 ${on ? 'bg-brand-50' : ''}`}>
                    <button type="button" onClick={() => pickPoint(b, 'saved')} className="min-w-0 flex-1 text-left">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="cr-num text-sm font-semibold text-ink-900">{b.code}</span>
                        <LevelChip level={levelOf(b.estimated_level)} pct={b.estimated_level} t={t} />
                        {b.status !== 'active' ? (
                          <span className="rounded-[4px] bg-warn-50 px-1.5 py-0.5 text-[11px] font-semibold text-warn-700">
                            {t('report.pendingApproval')}
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-sm text-ink-700">{b.name}</span>
                      <span className="mt-1 block text-[12px] text-ink-500">
                        {b.last_emptied_at
                          ? t('report.emptiedAt', { time: fmtDateTime(b.last_emptied_at, lang) })
                          : t('report.emptiedNone')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        forgetBin(b.id)
                        setBins(savedBins())
                        loadContext()
                      }}
                      aria-label={t('nav.close')}
                      className="shrink-0 rounded-[4px] p-2 text-ink-400 hover:bg-[#ebebeb] hover:text-ink-900"
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Panel>

      {/* -------------------------------------------------- chosen bin box */}
      {selected ? (
        <Panel
          title={selected.point.code}
          action={
            <Btn size="sm" variant="quiet" onClick={() => setSelected(null)}>
              {t('report.chooseDifferent')}
            </Btn>
          }
        >
          <div className="space-y-3 px-4 py-3">
            <p className="text-sm text-ink-700">{selected.point.name}</p>
            {selected.point.landmark ? <p className="text-[13px] text-ink-500">{selected.point.landmark}</p> : null}
            <div className="flex flex-wrap items-center gap-2">
              <LevelChip level={levelOf(selected.point.estimated_level)} pct={selected.point.estimated_level} t={t} />
              <span className="text-[13px] text-ink-500">{t('report.estimated', { level: Math.round(selected.point.estimated_level || 0) })}</span>
            </div>
            <LevelBar pct={selected.point.estimated_level} />
            {selected.point.id === null ? (
              <Notice tone="amber" title={t('report.pinApprove')}>
                {t('report.pinApproveHint')}
              </Notice>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {/* ------------------------------------------------------- pick a bin */}
      <Panel title={t('report.title')}>
        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              search(query)
            }}
          >
            <label htmlFor="bin-search" className="block text-sm font-medium text-ink-700">
              {t('report.search')}
            </label>
            <div className="mt-1.5 flex gap-2">
              <TextInput
                id="bin-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('report.searchPlaceholder')}
                autoComplete="off"
              />
              <Btn type="submit" variant="secondary" className="shrink-0" aria-label={t('report.searchBtn')}>
                <Search size={18} aria-hidden />
              </Btn>
            </div>
          </form>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              search(code)
            }}
          >
            <label htmlFor="bin-code" className="block text-sm font-medium text-ink-700">
              {t('report.code')}
            </label>
            <div className="mt-1.5 flex gap-2">
              <TextInput
                id="bin-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('report.codePlaceholder')}
                autoCapitalize="characters"
                autoComplete="off"
              />
              <Btn type="submit" variant="secondary" className="shrink-0" aria-label={t('report.codeBtn')}>
                <Search size={18} aria-hidden />
              </Btn>
            </div>
          </form>
        </div>

        {results.length ? (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    pickPoint(p, code.trim() ? 'typed' : 'search')
                    setResults([])
                    setCode('')
                    setQuery('')
                  }}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#f4f4f4]"
                >
                  <span className="min-w-0">
                    <span className="cr-num block text-sm font-semibold text-ink-900">{p.code}</span>
                    <span className="block truncate text-sm text-ink-700">{p.name}</span>
                    {p.landmark ? <span className="block truncate text-[12px] text-ink-500">{p.landmark}</span> : null}
                  </span>
                  <LevelChip level={levelOf(p.estimated_level)} pct={p.estimated_level} t={t} />
                </button>
              </li>
            ))}
          </ul>
        ) : query || code ? (
          <p className="border-t border-line-soft px-4 py-3 text-sm text-ink-500">{t('report.notFound')}</p>
        ) : null}

        <div className="border-t border-line-soft px-4 py-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-700">
            <MapPin size={16} aria-hidden />
            {t('report.pin')}
          </p>
          <p className="mb-2 text-[13px] text-ink-500">{t('report.pinHint')}</p>
          <MapView
            points={points}
            selectedPointId={selected?.point?.id || null}
            pin={pin}
            onMapClick={setPin}
            onPointClick={(p) => pickPoint(p, 'pin')}
            fit={!pin}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn variant="secondary" onClick={useMyLocation} loading={locating}>
              <Crosshair size={16} aria-hidden />
              {t('report.useLocation')}
            </Btn>
            {pin ? (
              <>
                <Btn variant="primary" onClick={confirmPin}>
                  <MapPin size={16} aria-hidden />
                  {t('report.pinConfirm')}
                </Btn>
                <Btn variant="quiet" onClick={() => setPin(null)}>
                  {t('nav.close')}
                </Btn>
              </>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* --------------------------------------------------- how full is it */}
      <Panel title={t('report.levelQuestion')}>
        <div className="space-y-3 px-4 py-4">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {LEVEL_WORDS.map((l) => {
              const selectedLevel = level === l
              return (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLevel(l)}
                  className={`flex min-h-[56px] flex-col items-center justify-center rounded-lg border px-3 py-3 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 sm:text-base ${
                    selectedLevel
                      ? 'border-brand-700 bg-brand-700 text-white'
                      : 'border-line bg-white text-ink-900 hover:bg-brand-50'
                  }`}
                  aria-pressed={selectedLevel}
                >
                  <span className="text-center">{t(`report.${l}`)}</span>
                </button>
              )
            })}
          </div>

          <div className="flex flex-wrap gap-2">
            <Btn variant="secondary" onClick={() => photoInput.current?.click()} disabled={!!photo}>
              <Camera size={16} aria-hidden />
              {t('report.photo')}
            </Btn>
            <Btn variant="secondary" onClick={toggleVoice} aria-pressed={listening}>
              {listening ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
              {listening ? t('report.speakStop') : t('report.speak')}
            </Btn>
          </div>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            className="cr-sr"
            onChange={(e) => onPhoto(e.target.files?.[0])}
          />
          {heard ? (
            <p className="text-[13px] text-ink-700">
              {t('report.voiceHeard', { text: heard })}
            </p>
          ) : null}
          {photo ? (
            <div className="flex items-start gap-3">
              <img src={photo} alt="" className="h-24 w-24 border border-line object-cover" />
              <Btn variant="quiet" size="sm" onClick={() => setPhoto(null)}>
                {t('report.skip')}
              </Btn>
            </div>
          ) : (
            <p className="text-[13px] text-ink-500">{t('report.photoOptional')}</p>
          )}

          {error ? <Notice tone="red">{error}</Notice> : null}
          {result2 ? (
            <Notice tone={result2.tone} title={result2.tone === 'green' ? t('report.send') : undefined} icon={result2.tone === 'green' ? CircleCheck : CircleAlert}>
              {result2.text}
              {result2.estimated !== undefined ? (
                <p className="mt-1 font-medium">{t('report.estimated', { level: result2.estimated })}</p>
              ) : null}
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Btn variant="primary" size="lg" onClick={submit} disabled={!canSend} loading={busy}>
              <Send size={18} aria-hidden />
              {t('report.send')}
            </Btn>
            <label className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink-700 shadow-sm sm:px-4 sm:py-2.5">
              <input
                type="checkbox"
                checked={saveIt}
                onChange={(e) => setSaveIt(e.target.checked)}
                className="h-5 w-5 accent-[#0f5132]"
              />
              {t('report.saveBin')}
            </label>
          </div>
          {saveIt && selected?.point?.id ? (
            <p className="text-[12px] text-ink-500">{t('report.deviceNote')}</p>
          ) : null}
        </div>
      </Panel>

      {/* ------------------------------------------------------- notices */}
      <Panel title={t('report.noticeTitle')} action={<Truck size={18} className="text-brand-700" aria-hidden />}>
        {notices.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-500">{t('report.emptiedNone')}</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {notices.map((n) => (
              <li key={`${n.point_id}-${n.created_at}`} className="px-4 py-3">
                <p className="text-sm font-medium text-ink-900">{n.name}</p>
                <p className="text-sm text-ink-700">{t('report.emptiedAt', { time: fmtDateTime(n.emptied_at, lang) })}</p>
                <p className="mt-1 text-[12px] text-ink-500">
                  {t('report.recent', { level: t(`report.${n.level}`), when: fmtAgo(n.created_at, lang, serverTime || mountedAt) })}
                </p>
              </li>
            ))}
          </ul>
        )}
        <div className="border-t border-line-soft px-4 py-3">
          <Row label={t('nav.language')} value={t(`lang.${lang}`)} />
          <Row label={t('driver.code')} value={<span className="cr-num">{me}</span>} />
          <Row
            label={t('report.rateLimit', { minutes: Math.round(state?.settings?.report_rate_limit_minutes || 30) })}
            value={t('common.yes')}
          />
        </div>
      </Panel>

      {selected ? (
        <Btn variant="quiet" onClick={() => navigate('/')}>
          {t('nav.back')}
        </Btn>
      ) : null}
    </div>
  )
}