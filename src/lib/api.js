// One place for JSON handling and offline detection, so every screen fails the
// same way on a phone with no signal.

const listeners = new Set()
let online = typeof navigator === 'undefined' ? true : navigator.onLine

const emit = () => {
  for (const fn of listeners) fn(online)
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    online = true
    emit()
  })
  window.addEventListener('offline', () => {
    online = false
    emit()
  })
}

export function onConnectivity(fn) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export const isOnline = () => online

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })

  let data = null
  const text = await res.text()
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { ok: false, error: text.slice(0, 200) }
    }
  }
  if (!res.ok) throw new ApiError(data?.error || `request failed (${res.status})`, res.status)
  // A reachable server answering ok:false is a normal outcome (wrong PIN,
  // duplicate report), not a transport failure. Call sites read `.ok`.
  return data || { ok: true }
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  del: (path) => request('DELETE', path),
}