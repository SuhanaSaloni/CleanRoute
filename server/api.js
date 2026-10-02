// HTTP API. Plain node:http, no framework. Every route reads or writes SQLite.

import * as S from './store.js'
import { getDb, DB_PATH } from './db.js'

const json = (res, code, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const ok = (res, body = { ok: true }) => json(res, 200, body)
const bad = (res, msg, code = 400) => json(res, code, { ok: false, error: msg })

async function body(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > 1_000_000) throw new Error('payload too large')
    chunks.push(c)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/**
 * Route table. Keys are "METHOD /path" or "METHOD /path/:param".
 * Returns { status, body } or { status: 0 } for no match.
 */
export async function handleApi(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '') || '/'
  const m = req.method
  const q = url.searchParams
  const seg = p.split('/').filter(Boolean)

  try {
    /* ---------------------------------------------------------- read-only */

    if (m === 'GET' && (p === '/' || p === '/health')) {
      return ok(res, { ok: true, db: DB_PATH, ...S.stats(), serverTime: S.simNow() })
    }

    if (m === 'GET' && p === '/state') return ok(res, S.statePayload())

    if (m === 'GET' && p === '/demo/logins') return ok(res, S.demoLogins())

    if (m === 'GET' && p === '/report/context') {
      const deviceId = q.get('device_id') || ''
      if (!deviceId) return bad(res, 'device_id is required')
      let saved = []
      try {
        saved = JSON.parse(q.get('saved') || '[]')
      } catch {
        saved = []
      }
      return ok(res, S.reportContext(deviceId, saved))
    }

    if (m === 'GET' && p === '/search') return ok(res, { results: S.suggestPoints(q.get('q') || '') })

    if (m === 'GET' && seg[0] === 'driver' && seg[1] === 'route') {
      const driverId = q.get('driver_id')
      const route = driverId ? S.driverRoute(driverId) : null
      if (!route) return bad(res, 'driver not found', 404)
      return ok(res, route)
    }

    if (m === 'GET' && p === '/savings') return ok(res, S.savingsPayload())
    if (m === 'GET' && p === '/race') return ok(res, S.racePayload())
    if (m === 'GET' && seg[0] === 'why') return ok(res, S.whyPayload(seg[1]) || { error: 'point not found' }, seg[1] ? 200 : 404)

    /* -------------------------------------------------------------- login */

    if (m === 'POST' && p === '/login') return ok(res, S.authLogin(await body(req)))

    /* ------------------------------------------------------------ citizen */

    if (m === 'POST' && p === '/device') {
      const b = await body(req)
      const deviceId = String(b.device_id || '').slice(0, 64)
      if (!deviceId) return bad(res, 'device_id is required')
      return ok(res, S.ensureDevice(deviceId))
    }

    if (m === 'POST' && p === '/report') {
      const b = await body(req)
      const deviceId = String(b.device_id || '').slice(0, 64)
      const level = ['empty', 'half', 'full', 'overflowing'].includes(b.level) ? b.level : null
      if (!deviceId) return bad(res, 'device_id is required')
      if (!level) return bad(res, 'level is required')
      let point = b.point_id ? S.getPoint(b.point_id) : null
      if (!point && Number.isFinite(Number(b.lat)) && Number.isFinite(Number(b.lng))) {
        const created = S.upsertPoint({
          name: b.name || 'New bin from citizen report',
          landmark: b.landmark || 'added from report',
          lat: Number(b.lat),
          lng: Number(b.lng),
          ward: b.ward || undefined,
          status: 'pending_approval',
          note: `added by ${deviceId}`,
        })
        point = S.getPoint(created.id)
      }
      if (!point) return bad(res, 'point not found')
      if (point.status !== 'active' && b.source !== 'pin') {
        return ok(res, { ok: true, pending: true, point: { id: point.id, code: point.code }, message: 'This bin is waiting for operator approval.' })
      }
      const res = S.addReport({
        pointId: point.id,
        deviceId,
        level,
        source: b.source || 'pin',
        lat: Number.isFinite(Number(b.lat)) ? Number(b.lat) : point.lat,
        lng: Number.isFinite(Number(b.lng)) ? Number(b.lng) : point.lng,
        photo: b.photo,
        photoNote: b.photo_note,
      })
      return ok(res, { ...res, point: { id: point.id, code: point.code, name: point.name, estimated_level: res.estimated } })
    }

    /* ------------------------------------------------------------- driver */

    if (m === 'POST' && p === '/action') {
      const b = await body(req)
      const actionId = String(b.action_id || '').slice(0, 80)
      if (!actionId || !b.driver_id) return bad(res, 'action_id and driver_id are required')
      return ok(res, S.applyDriverAction({ actionId, driverId: b.driver_id, kind: b.kind, payload: b.payload || {} }))
    }

    /* ----------------------------------------------------------- operator */

    if (m === 'POST' && p === '/routes/generate') return ok(res, S.generateRoutes())

    if (m === 'POST' && seg[0] === 'trucks' && seg[2] === 'status') {
      const b = await body(req)
      return ok(res, b.status === 'down' ? S.truckDown(seg[1], b.reason) : S.truckUp(seg[1]))
    }

    if (m === 'POST' && p === '/trucks') {
      const b = await body(req)
      if (b.delete) return ok(res, S.deleteTruck(b.id))
      return ok(res, S.upsertTruck(b))
    }

    if (m === 'POST' && p === '/drivers') return ok(res, S.upsertDriver(await body(req)))

    if (m === 'POST' && seg[0] === 'points' && seg[2]) {
      const b = await body(req)
      if (b.approve !== undefined) return ok(res, S.approvePoint(seg[1], !!b.approve, b.note || ''))
      return ok(res, S.upsertPoint({ ...b, id: seg[1] }))
    }

    if (m === 'POST' && p === '/points') return ok(res, S.upsertPoint(await body(req)))

    if (m === 'POST' && p === '/events') return ok(res, S.upsertEvent(await body(req)))

    if (m === 'DELETE' && seg[0] === 'events' && seg[1]) return ok(res, S.deleteEvent(seg[1]))

    if (m === 'POST' && p === '/roads/block') {
      const b = await body(req)
      return ok(res, S.setRoadBlocked(String(b.a), String(b.b), b.blocked !== false))
    }

    if (m === 'POST' && p === '/settings') {
      const b = await body(req)
      for (const [k, v] of Object.entries(b)) S.updateSetting(k, v)
      return ok(res)
    }

    /* ---------------------------------------------------------- custodian */

    if (m === 'POST' && p === '/pickups') return ok(res, S.addPickup(await body(req)))
    if (m === 'POST' && seg[0] === 'pickups' && seg[2] === 'status') {
      const b = await body(req)
      return ok(res, S.setPickupStatus(seg[1], b.status || 'open'))
    }

    /* --------------------------------------------------------------- demo */

    if (m === 'POST' && p === '/demo/reset') return ok(res, S.resetData())
    if (m === 'POST' && p === '/demo/fast-forward') return ok(res, S.fastForwardDay())
    if (m === 'POST' && p === '/demo/simulate-report') return ok(res, S.simulateReport(await body(req)))

    return { status: 0 }
  } catch (err) {
    getDb()
    return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
}