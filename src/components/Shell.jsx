// Page frame: brand bar, language and text-size controls, connectivity, and the
// phone bottom bar. Present on every screen so a person never has to hunt for
// the language or the way back.

import { useI18n } from '../i18n/index.jsx'
import { useStore } from '../lib/store.js'
import { navigate, usePath } from '../lib/router.js'
import { fmtClock } from '../lib/format.js'
import { Btn } from './ui.jsx'
import { Recycle, Type, Wifi, WifiOff, House, Trash, Truck, MonitorCog, Building } from 'lucide-react'

const TABS = [
  { path: '/', key: 'nav.home', Icon: House },
  { path: '/report', key: 'nav.report', Icon: Trash },
  { path: '/driver', key: 'nav.driver', Icon: Truck },
  { path: '/control', key: 'nav.control', Icon: MonitorCog },
  { path: '/custodian', key: 'nav.custodian', Icon: Building },
]

function Brand() {
  const { t } = useI18n()
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Recycle size={22} className="shrink-0 text-brand-700" aria-hidden />
      <div className="min-w-0">
        <p className="truncate text-[15px] font-semibold leading-tight text-ink-900">{t('app.name')}</p>
        <p className="truncate text-[11px] leading-tight text-ink-500">{t('app.tagline')}</p>
      </div>
    </div>
  )
}

function Controls() {
  const { t, lang, setLang, largeText, setLargeText } = useI18n()
  return (
    <div className="flex items-center gap-2">
      <div className="flex overflow-hidden rounded-[6px] border border-line" role="group" aria-label={t('nav.language')}>
        {[
          ['en', t('lang.en')],
          ['te', t('lang.te')],
          ['hi', t('lang.hi')],
        ].map(([code, label]) => (
          <button
            key={code}
            type="button"
            onClick={() => setLang(code)}
            aria-pressed={lang === code}
            className={`px-2.5 py-1.5 text-[13px] font-medium ${
              lang === code ? 'bg-brand-700 text-white' : 'bg-white text-ink-700 hover:bg-[#f0f0f0]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <Btn
        variant="secondary"
        size="sm"
        onClick={() => setLargeText(!largeText)}
        aria-pressed={largeText}
        aria-label={t('nav.largeText')}
        title={t('nav.largeText')}
        className="px-2.5"
      >
        <Type size={17} aria-hidden />
      </Btn>
    </div>
  )
}

function Connectivity() {
  const { t } = useI18n()
  const { state, online, updatedAt } = useStore()
  if (online) {
    return (
      <span className="hidden items-center gap-1.5 text-[12px] font-medium text-ink-500 sm:flex" title={t('home.live')}>
        <Wifi size={14} className="text-brand-700" aria-hidden />
        <span className="cr-num">{updatedAt ? fmtClock(updatedAt) : '...'}</span>
        <span className="cr-sr">{t('home.live')}</span>
        {state ? <span className="cr-num">v{state.version}</span> : null}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 rounded-[4px] bg-warn-50 px-2 py-0.5 text-[12px] font-semibold text-warn-700">
      <WifiOff size={14} aria-hidden />
      {t('common.offline')}
    </span>
  )
}

export default function Shell({ children }) {
  const { t } = useI18n()
  const path = usePath()

  return (
    <div className="min-h-dvh bg-canvas pb-16 sm:pb-0">
      <header className="sticky top-0 z-[1100] border-b border-line bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <a href="/" className="min-w-0 shrink rounded-[4px]" aria-label={t('nav.home')}>
            <Brand />
          </a>
          <div className="flex shrink-0 items-center gap-2">
            <Connectivity />
            <Controls />
          </div>
        </div>
        <nav aria-label={t('nav.menu')} className="hidden border-t border-line-soft sm:block">
          <ul className="mx-auto flex max-w-7xl gap-1 px-3 sm:px-4">
            {TABS.map((tb) => (
              <li key={tb.path}>
                <a
                  href={tb.path}
                  aria-current={path === tb.path ? 'page' : undefined}
                  className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium ${
                    path === tb.path
                      ? 'border-brand-700 text-brand-800'
                      : 'border-transparent text-ink-700 hover:text-ink-900'
                  }`}
                >
                  <tb.Icon size={16} aria-hidden />
                  {t(tb.key)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-4 sm:py-6">{children}</main>

      <nav
        aria-label={t('nav.menu')}
        className="fixed inset-x-0 bottom-0 z-[1100] border-t border-line bg-white sm:hidden"
      >
        <ul className="grid grid-cols-5">
          {TABS.map((tb) => {
            const on = path === tb.path
            return (
              <li key={tb.path}>
                <button
                  type="button"
                  onClick={() => navigate(tb.path)}
                  aria-current={on ? 'page' : undefined}
                  className={`flex min-h-16 w-full flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-medium ${
                    on ? 'bg-brand-50 text-brand-800' : 'text-ink-700'
                  }`}
                >
                  <tb.Icon size={20} aria-hidden />
                  <span className="leading-tight">{t(tb.key)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </div>
  )
}