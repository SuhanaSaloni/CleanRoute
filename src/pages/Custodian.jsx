// Custodian screen: a building or hospital caretaker asks for a pickup at a time
// they choose. No login, one short form, and the request lands in the control
// room queue where an operator can schedule it.

import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n/index.jsx'
import { useStore } from '../lib/store.js'
import { api } from '../lib/api.js'
import { queueRequest, useQueue } from '../lib/queue.js'
import { readPref, writePref } from '../lib/local.js'
import { fmtDateTime } from '../lib/format.js'
import { Btn, Field, Notice, Panel, Row, Select, TextArea, TextInput } from '../components/ui.jsx'
import { Send, CircleCheck, CircleAlert, Search, Building } from 'lucide-react'

const KINDS = ['household', 'bulk', 'hospital', 'market', 'office']
const KINDS_TE = ['గృహ వ్యర్థం', 'పెద్ద వ్యర్థం', 'ఆస్పత్రి', 'మార్కెట్', 'కార్యాలయం']
const KINDS_HI = ['घरेलू', 'बड़ा कचरा', 'अस्पताल', 'बाज़ार', 'कार्यालय']

export default function Custodian() {
  const { t, lang } = useI18n()
  const { state } = useStore()
  const { count } = useQueue()

  const wards = state?.wards || []
  const [form, setForm] = useState(() => ({
    custodian_name: readPref('custodian.name', ''),
    phone: readPref('custodian.phone', ''),
    ward: '',
    kind: 'bulk',
    needed_by: new Date(Date.now() + 864e5).toISOString().slice(0, 16),
    notes: '',
    point_id: '',
  }))
  const [results, setResults] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    setForm((f) => ({ ...f, ward: f.ward || wards[0]?.id || '' }))
  }, [wards])

  const kindLabels = useMemo(() => (lang === 'te' ? KINDS_TE : lang === 'hi' ? KINDS_HI : KINDS), [lang])
  const chosen = useMemo(() => (state?.points || []).find((p) => p.id === form.point_id), [state, form.point_id])

  async function searchPoint(q) {
    if (!q.trim()) return
    try {
      const res = await api.get(`/search?q=${encodeURIComponent(q)}`)
      setResults(res.results || [])
    } catch {
      setResults([])
    }
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const body = {
      custodian_name: form.custodian_name,
      phone: form.phone,
      ward: form.ward,
      kind: form.kind,
      needed_by: new Date(form.needed_by).toISOString(),
      notes: form.notes,
      point_id: form.point_id || null,
    }
    try {
      const res = await api.post('/pickups', body)
      if (!res.ok) setError(res.error || t('control.error'))
      else setDone({ id: res.id, at: new Date().toISOString() })
    } catch {
      queueRequest('/pickups', body, t('custodian.title'))
      setDone({ id: null, at: new Date().toISOString(), queued: true })
    } finally {
      writePref('custodian.name', form.custodian_name)
      writePref('custodian.phone', form.phone)
      setBusy(false)
    }
  }

  const mine = (state?.pickups || [])
    .filter((p) => p.phone && form.phone && p.phone === form.phone)
    .slice(0, 5)

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="flex items-center gap-2 text-xl font-semibold text-ink-900">
        <Building size={22} className="text-brand-700" aria-hidden />
        {t('custodian.title')}
      </h1>

      {count > 0 ? (
        <Notice tone="amber" icon={CircleAlert} title={t('driver.syncWaiting', { n: count })}>
          {t('driver.offlineQueued')}
        </Notice>
      ) : null}

      {done ? (
        <Notice tone="green" icon={CircleCheck} title={t('custodian.sent')}>
          <Btn size="sm" variant="secondary" onClick={() => setDone(null)}>
            {t('custodian.send')} {t('nav.retry')}
          </Btn>
        </Notice>
      ) : null}

      <Panel>
        <form onSubmit={submit} className="space-y-4 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('custodian.name')} htmlFor="cu-name">
              <TextInput
                id="cu-name"
                required
                value={form.custodian_name}
                onChange={(e) => setForm({ ...form, custodian_name: e.target.value })}
              />
            </Field>
            <Field label={t('custodian.phone')} htmlFor="cu-phone">
              <TextInput
                id="cu-phone"
                required
                inputMode="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('control.ward')} htmlFor="cu-ward">
              <Select
                id="cu-ward"
                value={form.ward}
                onChange={(e) => setForm({ ...form, ward: e.target.value })}
              >
                {wards.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.id} - {w.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('custodian.neededBy')} htmlFor="cu-when">
              <TextInput
                id="cu-when"
                type="datetime-local"
                required
                value={form.needed_by}
                onChange={(e) => setForm({ ...form, needed_by: e.target.value })}
              />
            </Field>
          </div>

          <Field label={t('custodian.kind')} htmlFor="cu-kind">
            <Select id="cu-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {KINDS.map((k, i) => (
                <option key={k} value={k}>
                  {kindLabels[i]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('report.search')} hint={t('report.searchPlaceholder')}>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                searchPoint(query)
              }}
            >
              <TextInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('report.searchPlaceholder')}
                aria-label={t('report.search')}
              />
              <Btn type="submit" variant="secondary" className="shrink-0" aria-label={t('report.searchBtn')}>
                <Search size={18} aria-hidden />
              </Btn>
            </form>
          </Field>

          {results.length ? (
            <ul className="divide-y divide-line-soft rounded-[6px] border border-line">
              {results.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setForm({ ...form, point_id: p.id, ward: form.ward || p.ward })
                      setResults([])
                    }}
                    className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-[#f4f4f4] ${
                      form.point_id === p.id ? 'bg-brand-50' : ''
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="cr-num block text-sm font-semibold text-ink-900">{p.code}</span>
                      <span className="block truncate text-sm text-ink-700">{p.name}</span>
                    </span>
                    <span className="cr-num shrink-0 text-[12px] text-ink-500">{Math.round(p.estimated_level)}%</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {chosen ? <Row label={t('report.code')} value={chosen.code} mono /> : null}

          <Field label={t('custodian.notes')} htmlFor="cu-notes">
            <TextArea
              id="cu-notes"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>

          {error ? <Notice tone="red">{error}</Notice> : null}

          <Btn type="submit" variant="primary" size="lg" loading={busy} disabled={!form.custodian_name || !form.phone}>
            <Send size={18} aria-hidden />
            {t('custodian.send')}
          </Btn>
        </form>
      </Panel>

      {mine.length ? (
        <Panel title={t('custodian.pending')}>
          <ul className="divide-y divide-line-soft">
            {mine.map((p) => (
              <li key={p.id} className="px-4 py-3">
                <Row
                  label={t('custodian.neededBy')}
                  value={fmtDateTime(p.needed_by, lang)}
                  mono
                />
                <Row label={t('common.status')} value={t(`custodian.${p.status === 'open' ? 'pending' : p.status === 'scheduled' ? 'scheduled' : 'done'}`)} />
                {p.notes ? <p className="mt-1 text-[13px] text-ink-500">{p.notes}</p> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  )
}