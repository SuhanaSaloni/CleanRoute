// One path, one screen. The router in lib/router.js turns plain <a href> into
// client navigation, so the pathname is all this file has to look at.

import { I18nProvider, useI18n } from './i18n/index.jsx'
import { installRouter, usePath } from './lib/router.js'
import Shell from './components/Shell.jsx'
import Home from './pages/Home.jsx'
import Report from './pages/Report.jsx'
import Driver from './pages/Driver.jsx'
import Control from './pages/Control.jsx'
import Custodian from './pages/Custodian.jsx'

installRouter()

const ROUTES = {
  '/': Home,
  '/report': Report,
  '/driver': Driver,
  '/control': Control,
  '/custodian': Custodian,
}

function Screen() {
  const { t } = useI18n()
  const path = usePath()
  const Page = ROUTES[path]

  if (Page) return <Page />

  return (
    <section className="mx-auto max-w-lg rounded-[6px] border border-line bg-white px-4 py-10 text-center">
      <h1 className="text-lg font-semibold text-ink-900">{t('nav.notFound')}</h1>
      <p className="cr-num mt-1 text-sm text-ink-500">{path}</p>
      <a
        href="/"
        className="mt-4 inline-block rounded-[6px] border border-brand-700 bg-brand-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-800"
      >
        {t('nav.home')}
      </a>
    </section>
  )
}

export default function App() {
  return (
    <I18nProvider>
      <Shell>
        <Screen />
      </Shell>
    </I18nProvider>
  )
}
