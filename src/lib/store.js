// One shared copy of /api/state, polled every 3 seconds while any screen is
// mounted. A single poll per tab instead of one per component, and the payload
// is only swapped when the server version changes.

import { useSyncExternalStore } from 'react'
import { api, isOnline, onConnectivity } from './api.js'

export const POLL_MS = 3000

let snap = { state: null, error: null, updatedAt: 0, online: isOnline() }
let lastVersion = -1
let timer = null
let inflight = false
const subs = new Set()

function set(patch) {
  snap = { ...snap, ...patch }
  for (const fn of subs) fn()
}

async function poll() {
  if (inflight) return
  inflight = true
  try {
    const state = await api.get('/state')
    const changed = state.version !== lastVersion
    lastVersion = state.version
    set({ state: changed || !snap.state ? state : snap.state, error: null, updatedAt: Date.now(), online: true })
  } catch (err) {
    // Being offline is expected, so it is not surfaced as an error state.
    if (isOnline()) set({ error: err, updatedAt: Date.now() })
  } finally {
    inflight = false
  }
}

function subscribe(fn) {
  subs.add(fn)
  if (!timer) {
    timer = setInterval(poll, POLL_MS)
    poll()
  }
  return () => {
    subs.delete(fn)
    if (!subs.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

export function useStore() {
  return useSyncExternalStore(subscribe, () => snap)
}

export function refreshStore() {
  return poll()
}

/** POST then pull the new state straight away, so the UI never waits 3 seconds. */
export async function send(path, body) {
  const out = await api.post(path, body)
  await poll()
  return out
}

onConnectivity((online) => {
  set({ online })
  if (online) poll()
})