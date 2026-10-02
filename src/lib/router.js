// Minimal history router. Plain <a href> keeps bookmarks and the back button
// working, and one click handler turns same-origin links into client navigation.

import { useSyncExternalStore } from 'react'

const subs = new Set()
const normalise = (p) => p.replace(/\/+$/, '') || '/'
let path = normalise(typeof location === 'undefined' ? '/' : location.pathname)

function emit() {
  for (const fn of subs) fn()
}

export function navigate(to, replace = false) {
  const next = normalise(to)
  if (next === path) return
  if (replace) history.replaceState(null, '', next)
  else history.pushState(null, '', next)
  path = next
  window.scrollTo(0, 0)
  emit()
}

const subscribe = (fn) => {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
const snapshot = () => path

export function usePath() {
  return useSyncExternalStore(subscribe, snapshot)
}

let installed = false

export function installRouter() {
  if (installed) return
  installed = true
  window.addEventListener('popstate', () => {
    path = normalise(location.pathname)
    emit()
  })
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target.closest?.('a[href]')
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return
    const href = a.getAttribute('href')
    if (!href || !href.startsWith('/')) return
    e.preventDefault()
    navigate(href)
  })
}