// Front door. Language first, because a person who cannot read the screen
// cannot pick anything else, then the three jobs this build supports.

import { useI18n } from '../i18n/index.jsx'
import { Trash, Truck, MonitorCog } from 'lucide-react'

// English, Telugu, Hindi. Each name is written in its own script in the
// dictionaries, so a person who cannot read the current UI can still find it.
const LANGS = ['en', 'te', 'hi']

const CARDS = [
  { href: '/report', title: 'home.card.report', desc: 'home.report.desc', Icon: Trash },
  { href: '/driver', title: 'home.card.driver', desc: 'home.driver.desc', Icon: Truck },
  { href: '/control', title: 'home.card.control', desc: 'home.control.desc', Icon: MonitorCog },
]

export default function Home() {
  const { t, lang, setLang } = useI18n()

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section aria-labelledby="lang-h">
        <h1 id="lang-h" className="text-sm font-semibold text-ink-700">
          {t('home.pickLanguage')}
        </h1>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {LANGS.map((code) => {
            const on = lang === code
            return (
              <button
                key={code}
                type="button"
                onClick={() => setLang(code)}
                aria-pressed={on}
                className={`min-h-14 rounded-[6px] border px-4 text-base font-medium ${
                  on
                    ? 'border-brand-700 bg-brand-700 text-white'
                    : 'border-line bg-white text-ink-900 hover:bg-[#f4f4f4]'
                }`}
              >
                {t(`lang.${code}`)}
              </button>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="cards-h" className="grid gap-3 sm:grid-cols-3">
        <h2 id="cards-h" className="cr-sr">
          {t('home.pickRole')}
        </h2>
        {CARDS.map(({ href, title, desc, Icon }) => (
          <a
            key={href}
            href={href}
            className="flex flex-col gap-2 rounded-[6px] border border-line bg-white p-4 hover:border-brand-300 hover:bg-brand-50"
          >
            <Icon size={22} className="text-brand-700" aria-hidden />
            <span className="text-[15px] font-semibold text-ink-900">{t(title)}</span>
            <span className="text-sm text-ink-500">{t(desc)}</span>
          </a>
        ))}
      </section>
    </div>
  )
}
