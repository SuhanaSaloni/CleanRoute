// Browser-local storage. This is the only place that keeps citizen reports and
// driver actions usable with no signal: a random device code, the bins a person
// saved on their phone, and the queue of driver actions waiting to sync.

const DEVICE_KEY = 'cleanroute.deviceId'
const BINS_KEY = 'cleanroute.bins'
const QUEUE_KEY = 'cleanroute.queue'
const ROUTE_KEY = 'cleanroute.driverRoute'
const SESSION_KEY = 'cleanroute.session'

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Private browsing or a full quota. The app still works, it just forgets.
  }
}

function drop(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------- anonymous device id */

export function deviceId() {
  let id = read(DEVICE_KEY, null)
  if (typeof id !== 'string' || !id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`
    write(DEVICE_KEY, id)
  }
  return id
}

/* ------------------------------------------------------------- saved bins */

export const savedBins = () => {
  const list = read(BINS_KEY, [])
  return Array.isArray(list) ? list : []
}

export function saveBin(id) {
  const list = savedBins()
  if (list.includes(id)) return list
  const next = [...list, id]
  write(BINS_KEY, next)
  return next
}

export function forgetBin(id) {
  write(
    BINS_KEY,
    savedBins().filter((x) => x !== id),
  )
}

/* ------------------------------------------------- offline action queue */

export const pendingActions = () => {
  const list = read(QUEUE_KEY, [])
  return Array.isArray(list) ? list : []
}

export function enqueueAction(action) {
  const next = [...pendingActions(), action]
  write(QUEUE_KEY, next)
  return next.length
}

export function dequeueAction(actionId) {
  const next = pendingActions().filter((a) => a.action_id !== actionId)
  write(QUEUE_KEY, next)
  return next.length
}

/** Used by the retry loop so a permanently failing entry stops blocking. */
export function patchAction(actionId, patch) {
  const next = pendingActions().map((a) => (a.action_id === actionId ? { ...a, ...patch } : a))
  write(QUEUE_KEY, next)
  return next.length
}

export function clearQueue() {
  drop(QUEUE_KEY)
}

export function newActionId() {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ------------------------------------------------- cached driver route */

export function cacheRoute(driverId, route) {
  write(ROUTE_KEY, { driverId, at: Date.now(), route })
}

export function cachedRoute(driverId) {
  const hit = read(ROUTE_KEY, null)
  return hit && hit.driverId === driverId ? hit : null
}

/* ------------------------------------------------------------- session */

export const getSession = () => read(SESSION_KEY, null)
export const setSession = (session) => write(SESSION_KEY, session)
export function clearSession() {
  drop(SESSION_KEY)
}

/* --------------------------------------------------------- preferences */

export const readPref = (key, fallback) => {
  const v = read(`cleanroute.${key}`, fallback)
  return v === null || v === undefined ? fallback : v
}

export const writePref = (key, value) => write(`cleanroute.${key}`, value)