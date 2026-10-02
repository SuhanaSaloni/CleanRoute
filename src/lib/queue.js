// Offline queue shared by the citizen report screen and the driver screen. An
// entry is just "POST this body to this path when the network returns", so both
// screens survive a dead zone in the same way and use the same retry rules.

import { useEffect, useSyncExternalStore } from 'react'
import { api, isOnline, onConnectivity } from './api.js'
import { dequeueAction, patchAction, pendingActions, newActionId, enqueueAction } from './local.js'

const MAX_ATTEMPTS = 5

let count = pendingActions().length
let syncing = false
const subs = new Set()

function setCount(n) {
  if (n === count) return
  count = n
  for (const fn of subs) fn()
}

const subscribe = (fn) => {
  subs.add(fn)
  return () => {
    subs.delete(fn)
  }
}
const snapshot = () => count

/** Pending actions plus a live flush, so the badge updates on its own. */
export function useQueue() {
  useSyncExternalStore(subscribe, snapshot)
  useEffect(() => {
    setCount(pendingActions().length)
    if (isOnline()) flushQueue()
  }, [])
  return { count, flushQueue }
}

/** Add one entry. Returns the new queue size. */
export function queueRequest(path, body, label = '') {
  const action = { action_id: newActionId(), path, body, label, at: new Date().toISOString(), attempts: 0 }
  const n = enqueueAction(action)
  setCount(n)
  if (isOnline()) flushQueue()
  return n
}

/**
 * Send everything in order. Stops at the first transport failure so a queue
 * never reorders itself, and gives up on an entry after MAX_ATTEMPTS tries.
 */
export async function flushQueue() {
  if (syncing || !isOnline()) return count
  syncing = true
  try {
    for (const item of pendingActions()) {
      try {
        await api.post(item.path, item.body)
        setCount(dequeueAction(item.action_id))
      } catch {
        const attempts = (item.attempts || 0) + 1
        if (attempts >= MAX_ATTEMPTS) {
          setCount(dequeueAction(item.action_id))
          continue
        }
        setCount(patchAction(item.action_id, { attempts }))
        break
      }
    }
  } finally {
    syncing = false
  }
  return count
}

onConnectivity((online) => {
  if (online) flushQueue()
})