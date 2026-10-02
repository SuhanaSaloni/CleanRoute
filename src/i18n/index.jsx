// One translation source, three languages. Language names are always shown in
// their own script so a person who cannot read the current UI can still find
// their language.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { en } from './en.js'
import { hi } from './hi.js'
import { te } from './te.js'

export const DICTIONARIES = { en, hi, te }
export const LANGS = ['en', 'hi', 'te']
const STORAGE_KEY = 'cleanroute.lang'
const FONT_KEY = 'cleanroute.largeText'

export const I18nContext = createContext(null)

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}

function readLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && LANGS.includes(saved)) return saved
  } catch {
    /* localStorage can be blocked; fall through to the browser preference */
  }
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const short = String(l).slice(0, 2)
    if (LANGS.includes(short)) return short
  }
  return 'en'
}

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(readLang)
  const [largeText, setLargeText] = useState(() => {
    try {
      return localStorage.getItem(FONT_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dataset.lang = lang
    try {
      localStorage.setItem(STORAGE_KEY, lang)
    } catch {
      /* ignore */
    }
  }, [lang])

  useEffect(() => {
    document.documentElement.dataset.largeText = largeText ? '1' : '0'
    try {
      localStorage.setItem(FONT_KEY, largeText ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [largeText])

  const setLang = useCallback((l) => {
    if (LANGS.includes(l)) setLangState(l)
  }, [])

  const t = useCallback(
    (key, vars) => {
      const table = DICTIONARIES[lang] || en
      let out = table[key] ?? en[key] ?? key
      if (vars) {
        for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v))
      }
      return out
    },
    [lang],
  )

  const value = useMemo(
    () => ({ lang, setLang, t, largeText, setLargeText, langs: LANGS }),
    [lang, setLang, t, largeText],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}