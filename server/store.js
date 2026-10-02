// Data access and business logic. Every function here reads and writes the real
// SQLite database. The algorithms in src/algorithms stay pure.

import { randomUUID } from 'node:crypto'
import { all, get, run, tx, wipe, bumpVersion, version, logActivity, settings, setSetting, getDb } from './db.js'
import {
  DEPOT,
  YARDS,
  WARDS,
  seedRoadGraph,
  seedPoints,
  seedTrucks,
  seedDrivers,
  seedOperators,
  seedEvents,
  seedSettings,
  seedDevices,
  seedHistory,
} from './seed.js'
import {
  buildGraph,
  snapNode,
  estimateLevel,
  priorityOf,
  baseLevel,
  blendReports,
  reportsSinceEmpty,
  activeEventMultiplier,
  REPORT_WINDOW_HOURS,
  AREA_FACTOR,
} from '../src/algorithms/index.js'
import { onEmptied, onNothingToCollect, trustAfterReport, flagDevices, clamp } from '../src/algorithms/learning.js'
import { planRoutes, insertUrgent, redistribute, reasonFor } from '../src/algorithms/dispatch.js'
import { savingsCompare, race } from '../src/algorithms/savings.js'

const nowIso = () => new Date().toISOString()
const id = (p) => `${p}-${randomUUID().slice(0, 8)}`

/* ------------------------------------------------------------------ seeding */

export function isSeeded() {
  return Number(get('SELECT COUNT(*) AS c FROM collection_points')?.c || 0) > 0
}

export function seedAll() {
  const now = Date.now()
  return tx(() => {
    wipe()

    for (const [k, v] of Object.entries(seedSettings())) setSetting(k, v)

    const { nodes, edges } = seedRoadGraph()
    for (const n of nodes) run('INSERT INTO road_nodes(id,lat,lng,label) VALUES(?,?,?,?)', [n.id, n.lat, n.lng, n.label])
    for (const e of edges) run('INSERT INTO road_edges(a,b,km,name,blocked) VALUES(?,?,NULL,?,0)', [e.a, e.b, e.name])

    const places = [DEPOT, ...YARDS]
    for (const p of places) run('INSERT INTO places(id,name,kind,lat,lng) VALUES(?,?,?,?,?)', [p.id, p.name, p.kind, p.lat, p.lng])

    const points = seedPoints()
    for (const p of points) {
      run(
        `INSERT INTO collection_points
         (id,code,name,landmark,lat,lng,ward,area_type,type,base_fill_rate,estimated_level,last_emptied_at,status,expected_load_kg,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,NULL,'active',?,?)`,
        [p.id, p.code, p.name, p.landmark, p.lat, p.lng, p.ward, p.area_type, p.type, p.base_fill_rate, p.expected_load_kg, nowIso()],
      )
    }

    for (const t of seedTrucks()) {
      run('INSERT INTO trucks(id,name,plate,capacity_kg,status,driver_id) VALUES(?,?,?,?,?,?)', [
        t.id, t.name, t.plate, t.capacity_kg, t.status, t.driver_id,
      ])
    }
    for (const d of seedDrivers()) run('INSERT INTO drivers(id,name,phone,pin,truck_id) VALUES(?,?,?,?,?)', [d.id, d.name, d.phone, d.pin, d.truck_id])
    for (const o of seedOperators()) run('INSERT INTO operators(email,password,name) VALUES(?,?,?)', [o.email, o.password, o.name])

    const evs = seedEvents(now)
    for (const e of evs) {
      run('INSERT INTO events(id,name,ward,start,end,multiplier,status,created_at) VALUES(?,?,?,?,?,?,?,?)', [
        e.id, e.name, e.ward, e.start, e.end, e.multiplier, e.status, nowIso(),
      ])
    }

    const devices = seedDevices(now)
    for (const d of devices) run('INSERT INTO devices(device_id,trust,first_seen,last_seen,reports) VALUES(?,?,?,?,0)', [d.device_id, d.trust, d.first_seen, d.last_seen])

    const { reports, emptied, preds } = seedHistory(points, devices, now)
    for (const r of reports) {
      run('INSERT INTO reports(point_id,device_id,level,source,lat,lng,created_at) VALUES(?,?,?,?,?,?,?)', [
        r.point_id, r.device_id, r.level, r.source, r.lat, r.lng, r.created_at,
      ])
    }
    // Latest empty becomes last_emptied_at so histories line up with real service.
    for (const p of points) {
      const list = (emptied[p.id] || []).map((x) => x.at).filter((a) => new Date(a).getTime() <= now).sort()
      const last = list.at(-1)
      if (!last) {
        // No service in the seeded window: fall back to a plausible past time.
        const gapH = 6 + (p.base_fill_rate % 6)
        run('UPDATE collection_points SET last_emptied_at = ? WHERE id = ?', [new Date(now - gapH * 36e5).toISOString(), p.id])
      } else {
        run('UPDATE collection_points SET last_emptied_at = ? WHERE id = ?', [last, p.id])
      }
      const est = estimateLevel(getPoint(p.id), reportsFor(p.id), allDevices(), allEvents(), now)
      run('UPDATE collection_points SET estimated_level = ? WHERE id = ?', [Math.round(est * 10) / 10, p.id])
    }
    for (const d of devices) {
      const c = get('SELECT COUNT(*) AS c FROM reports WHERE device_id = ?', [d.device_id])?.c || 0
      run('UPDATE devices SET reports = ? WHERE device_id = ?', [c, d.device_id])
    }
    const levelById = new Map(all('SELECT id, estimated_level FROM collection_points').map((r) => [r.id, r.estimated_level]))
    for (const p of preds.slice(-600)) {
      run(
        'INSERT INTO prediction_log(point_id,at,predicted_level,predicted_hours,actual_hours,error_hours,outcome) VALUES(?,?,?,?,?,?,?)',
        [
          p.point_id,
          p.at,
          Math.min(100, Math.round((levelById.get(p.point_id) ?? 100) * 10) / 10),
          p.predicted_hours,
          p.actual_hours,
          +(p.actual_hours - p.predicted_hours).toFixed(2),
          p.outcome,
        ],
      )
    }

    for (const p of points) {
      run('UPDATE collection_points SET node_id = ? WHERE id = ?', [snapNode(loadGraph(), p.lat, p.lng).id, p.id])
    }

    run('INSERT INTO meta(key,value) VALUES(?,?)', ['seeded_at', nowIso()])
    run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ['clock_offset', '0'])
    logActivity('seed', `Seeded ${points.length} points, ${devices.length} devices, ${HISTORY_LABEL}`)
    bumpVersion()
  })
}

const HISTORY_LABEL = '30 days of history'

/** Advance the simulated clock. Persisted so reports stay consistent. */
export function clockOffsetMs() {
  return Number(get('SELECT value FROM meta WHERE key = ?', ['clock_offset'])?.value || 0)
}

export function setClockOffset(ms) {
  run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [
    'clock_offset', String(Math.round(ms)),
  ])
}

export function simNow() {
  return Date.now() + clockOffsetMs()
}

/* -------------------------------------------------------------- graph/data */

let graphCache = null
export function loadGraph() {
  if (graphCache && !graphCacheStale()) return graphCache
  const nodes = all('SELECT id,lat,lng FROM road_nodes')
  const edges = all('SELECT a,b,km,blocked FROM road_edges')
  graphCache = buildGraph(nodes, edges)
  graphCacheStale = () => false
  return graphCache
}
let graphCacheStale = () => false
export function invalidateGraph() {
  graphCacheStale = () => true
  graphCache = null
}

export const allDevices = () => all('SELECT * FROM devices')
export const allEvents = () => all('SELECT * FROM events')
export const allPoints = () => all("SELECT * FROM collection_points WHERE status = 'active' ORDER BY code")
export const allPointsIncludingPending = () => all('SELECT * FROM collection_points ORDER BY code')
export const allTrucks = () => all('SELECT * FROM trucks')
export const allDrivers = () => all('SELECT * FROM drivers')
export const places = () => all('SELECT * FROM places')
export const dumpYards = () => places().filter((p) => p.kind === 'dump_yard')
export const getPoint = (pid) => get('SELECT * FROM collection_points WHERE id = ?', [pid])
export const reportsFor = (pid) =>
  all('SELECT * FROM reports WHERE point_id = ? ORDER BY created_at DESC LIMIT 200', [pid])

/** Recompute estimated_level for every active point. Cheap at this scale. */
export function refreshEstimates(at = simNow()) {
  const points = allPoints()
  const devices = allDevices()
  const events = allEvents()
  const byPoint = groupBy(all('SELECT * FROM reports WHERE created_at > ?', [new Date(at - REPORT_WINDOW_HOURS * 36e5).toISOString()]), 'point_id')
  for (const p of points) {
    const level = estimateLevel(p, byPoint[p.id] || [], devices, events, at)
    if (Math.abs((p.estimated_level || 0) - level) > 0.05) {
      run('UPDATE collection_points SET estimated_level = ? WHERE id = ?', [Math.round(level * 10) / 10, p.id])
      p.estimated_level = Math.round(level * 10) / 10
    }
  }
}

/** Candidate rows: level, reports since emptied, priority. */
export function buildCandidates(at = simNow()) {
  const points = allPoints()
  const devices = allDevices()
  const events = allEvents()
  const reports = all(
    'SELECT * FROM reports WHERE created_at > ?',
    [new Date(at - 72 * 36e5).toISOString()],
  )
  const byPoint = groupBy(reports, 'point_id')
  return points.map((p, i) => {
    const live = (byPoint[p.id] || []).filter(
      (r) => new Date(r.created_at).getTime() <= at && new Date(r.created_at).getTime() > at - REPORT_WINDOW_HOURS * 36e5,
    )
    const since = reportsSinceEmpty(p, byPoint[p.id] || [], at)
    const blend = blendReports(baseLevel(p, events, at), byPoint[p.id] || [], devices, at)
    const pri = priorityOf(p, blend.level, since, at)
    return {
      ...p,
      point_id: p.id,
      i: i + 1,
      level: Math.round(blend.level * 10) / 10,
      priority: Math.round(pri.priority * 10) / 10,
      hoursWaiting: Math.round(pri.hoursWaiting * 10) / 10,
      extraReports: pri.extraReports,
      sensitiveBonus: pri.sensitiveBonus,
      reportsSinceEmpty: since.length,
      recentReports: live.length,
      agree: blend.agree || 0,
      base: Math.round(blend.base || 0),
      eventMultiplier: activeEventMultiplier(p, events, at),
    }
  })
}

function groupBy(rows, key) {
  const out = {}
  for (const r of rows) (out[r[key]] = out[r[key]] || []).push(r)
  return out
}

/* ------------------------------------------------------------------ routes */

export function generateRoutes(at = simNow()) {
  const s = settings()
  refreshEstimates(at)
  const candidates = buildCandidates(at)
  const liveStops = all("SELECT * FROM stops WHERE status != 'done'")
  const plan = planRoutes({
    graph: loadGraph(),
    depot: get('SELECT * FROM places WHERE kind = ? LIMIT 1', ['depot']),
    points: allPoints(),
    yards: dumpYards(),
    trucks: allTrucks(),
    candidates,
    settings: s,
    liveStops,
  })

  return tx(() => {
    run('DELETE FROM stops')
    run('DELETE FROM routes')
    const rid = `route-${new Date(at).toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`
    const points = plan.points
    const candById = new Map(candidates.map((c) => [c.point_id, c]))
    const today = new Date(at).toISOString().slice(0, 10)
    const results = []

    for (const r of plan.routes) {
      const rid2 = `${rid}-${r.truck_id}`
      run('INSERT INTO routes(id,truck_id,day,km,minutes,solver,exact,created_at) VALUES(?,?,?,?,?,?,?,?)', [
        rid2, r.truck_id, today, r.km, r.minutes, r.solver, r.exact ? 1 : 0, new Date(at).toISOString(),
      ])
      let order = 0
      for (const s2 of r.stops) {
        const point = points[s2.matrixIndex - 1]
        if (!point) continue
        order += 1
        const cand = candById.get(point.id)
        const reason = reasonFor({ ...cand, forced: cand && cand.priority >= s.forced_threshold })
        run(
          'INSERT INTO stops(id,route_id,truck_id,point_id,stop_order,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
          [id('stp'), rid2, r.truck_id, point.id, order, reason, s2.status || 'pending', new Date(at).toISOString()],
        )
      }
      results.push({ truck_id: r.truck_id, stops: order, km: r.km, minutes: r.minutes, solver: r.solver, exact: r.exact })
    }
    logActivity('route', `Generated routes for ${results.length} trucks, ${plan.selection.selected.length} stops`)
    bumpVersion()
    return { routes: results, selection: { ...plan.selection, selected: undefined }, deferredCount: plan.selection.deferred.length }
  })
}

/** Route payload for the driver app. Small enough to cache fully offline. */
export function driverRoute(driverId) {
  const driver = get('SELECT * FROM drivers WHERE id = ?', [driverId])
  if (!driver) return null
  const truck = driver.truck_id ? get('SELECT * FROM trucks WHERE id = ?', [driver.truck_id]) : null
  const stops = truck
    ? all('SELECT * FROM stops WHERE truck_id = ? ORDER BY stop_order', [truck.id])
    : []
  const byId = new Map(allPointsIncludingPending().map((p) => [p.id, p]))
  return {
    driver: { id: driver.id, name: driver.name, phone: driver.phone },
    truck: truck ? { id: truck.id, name: truck.name, plate: truck.plate, capacity_kg: truck.capacity_kg, status: truck.status } : null,
    stops: stops.map((s) => {
      const p = byId.get(s.point_id)
      return {
        id: s.id,
        order: s.stop_order,
        point_id: s.point_id,
        code: p?.code,
        name: p?.name,
        landmark: p?.landmark,
        lat: p?.lat,
        lng: p?.lng,
        ward: p?.ward,
        area_type: p?.area_type,
        type: p?.type,
        estimated_level: p?.estimated_level,
        last_emptied_at: p?.last_emptied_at,
        reason: s.reason,
        status: s.status,
        action_note: s.action_note,
        arrived_at: s.arrived_at,
      }
    }),
    serverTime: simNow(),
  }
}

/* ------------------------------------------------------------ citizen flow */

export function ensureDevice(deviceId) {
  const d = get('SELECT * FROM devices WHERE device_id = ?', [deviceId])
  if (d) {
    run('UPDATE devices SET last_seen = ? WHERE device_id = ?', [nowIso(), deviceId])
    return { device: d, created: false }
  }
  run('INSERT INTO devices(device_id,trust,first_seen,last_seen,reports) VALUES(?,?,?,?,0)', [
    deviceId, 0.5, nowIso(), nowIso(),
  ])
  bumpVersion()
  return { device: get('SELECT * FROM devices WHERE device_id = ?', [deviceId]), created: true }
}

export function recentReportFromDevice(pointId, deviceId, minutes) {
  const since = new Date(Date.now() - minutes * 60e3).toISOString()
  return get('SELECT * FROM reports WHERE point_id = ? AND device_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1', [
    pointId, deviceId, since,
  ])
}

export function addReport({ pointId, deviceId, level, source, lat, lng, photo, photoNote }) {
  const s = settings()
  if (!source) source = 'pin'
  const latNum = Number.isFinite(Number(lat)) ? Number(lat) : null
  const lngNum = Number.isFinite(Number(lng)) ? Number(lng) : null
  const photoData = normalisePhoto(photo)
  return tx(() => {
    const dup = recentReportFromDevice(pointId, deviceId, s.report_rate_limit_minutes || 30)
    if (dup) {
      return { ok: false, duplicate: true, reason: 'rate_limited', existing: dup }
    }
    const at = simNow()
    run('INSERT INTO reports(point_id,device_id,level,source,lat,lng,photo,photo_note,created_at) VALUES(?,?,?,?,?,?,?,?,?)', [
      pointId, deviceId, level, source, latNum, lngNum, photoData, String(photoNote || '').slice(0, 200), new Date(at).toISOString(),
    ])
    run('UPDATE devices SET last_seen = ?, reports = reports + 1 WHERE device_id = ?', [new Date(at).toISOString(), deviceId])

    // Trust update for the reporting device.
    const others = all('SELECT * FROM reports WHERE point_id = ? AND device_id != ? ORDER BY created_at DESC LIMIT 20', [pointId, deviceId])
    const point = getPoint(pointId)
    const predicted = point ? estimateLevel(point, reportsFor(pointId), allDevices(), allEvents(), at) : 50
    const dev = get('SELECT * FROM devices WHERE device_id = ?', [deviceId])
    if (dev) {
      const t = trustAfterReport(dev, { level }, others, predicted)
      run('UPDATE devices SET trust = ? WHERE device_id = ?', [t.trust, deviceId])
      logActivity('trust', `Device ${deviceId} trust ${dev.trust} -> ${t.trust} (${t.why})`)
    }

    refreshEstimates(at)
    const live = liveLiveStopFor(pointId)
    let inserted = null
    if (live) {
      const cands = buildCandidates(at)
      const cand = cands.find((c) => c.point_id === pointId)
      inserted = maybeInsertUrgent(cand, at)
    }
    logActivity('report', `${level} report on ${point?.code || pointId} from ${deviceId}${photoData ? ' with photo' : ''}`)
    bumpVersion()
    return {
      ok: true,
      duplicate: false,
      level,
      estimated: Math.round(getPoint(pointId)?.estimated_level || 0),
      inserted,
      photo: photoData ? 1 : 0,
    }
  })
}

/** Only small inline images are kept, so a database stays light. */
function normalisePhoto(photo) {
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) return null
  const b64 = photo.slice(photo.indexOf(',') + 1)
  if (b64.length > 900_000) return null
  return photo.slice(0, 4000 + b64.length)
}

function liveLiveStopFor(pointId) {
  return get("SELECT * FROM stops WHERE point_id = ? AND status = 'pending'", [pointId])
}

/** Live change: a newly urgent point is inserted where it costs the least. */
export function maybeInsertUrgent(cand, at = simNow()) {
  if (!cand) return null
  const s = settings()
  if (cand.priority < s.threshold) return null
  const already = get("SELECT * FROM stops WHERE point_id = ? AND status = 'pending'", [cand.point_id])
  if (already) return null

  const points = allPoints()
  const placesIdx = new Map(points.map((p, i) => [p.id, i + 1]))
  const liveStops = all("SELECT * FROM stops WHERE status != 'done'")
  if (liveStops.length === 0) return null

  const ordered = liveStops.sort((a, b) => (a.truck_id === b.truck_id ? a.stop_order - b.stop_order : a.truck_id < b.truck_id ? -1 : 1))
  const byTruck = new Map()
  for (const st of ordered) {
    if (!byTruck.has(st.truck_id)) byTruck.set(st.truck_id, [])
    byTruck.get(st.truck_id).push(st)
  }

  const plan = planRoutes({
    graph: loadGraph(),
    depot: get('SELECT * FROM places WHERE kind = ? LIMIT 1', ['depot']),
    points,
    yards: dumpYards(),
    trucks: allTrucks(),
    candidates: [],
    settings: s,
    liveStops: null,
  })
  const matrix = plan.matrix
  const loadOf = plan.loadOf
  const yardIndex = plan.yardIndex
  const trucks = allTrucks()

  let best = null
  for (const [truckId, list] of byTruck) {
    const truck = trucks.find((t) => t.id === truckId)
    if (!truck) continue
    const idxs = list.map((st) => placesIdx.get(st.point_id)).filter((x) => x != null)
    const res = insertUrgent([{ truck_id: truckId, seq: [0, ...idxs, 0], km: 0 }], matrix, cand.i, yardIndex, loadOf, [truck])
    if (res && (!best || res.addedKm < best.addedKm)) best = { ...res, truckId }
  }
  if (!best) return null

  // Insert at the position the planner chose and shift the rest down.
  const list = byTruck.get(best.truckId)
  const seq = best.seq
  const newPos = seq.indexOf(cand.i)
  const before = seq[newPos - 1]
  const currentIdx = list.map((st) => placesIdx.get(st.point_id))
  let insertAt = currentIdx.length
  for (let i = 0; i < currentIdx.length; i++) {
    if (currentIdx[i] === before) {
      insertAt = i + 1
      break
    }
  }
  for (let i = list.length - 1; i >= insertAt; i--) {
    run('UPDATE stops SET stop_order = ? WHERE id = ?', [i + 2, list[i].id])
  }
  const routeId = list[0]?.route_id || null
  run(
    'INSERT INTO stops(id,route_id,truck_id,point_id,stop_order,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [id('stp'), routeId, best.truckId, cand.point_id, insertAt + 1,
      reasonFor({ ...cand, forced: cand.priority >= s.forced_threshold }), 'pending', new Date(at).toISOString()],
  )
  logActivity('route', `Inserted ${cand.code} into ${best.truckId} route, +${best.addedKm} km`)
  return { truck_id: best.truckId, addedKm: best.addedKm, order: insertAt + 1 }
}

export function suggestPoints(q, at = simNow()) {
  const needle = (q || '').trim().toLowerCase()
  if (!needle) return []
  const points = allPointsIncludingPending()
  const scored = points
    .map((p) => {
      let score = 0
      if (p.code.toLowerCase() === needle) score = 100
      else if (p.code.toLowerCase().startsWith(needle)) score = 80
      else if (p.name.toLowerCase().includes(needle)) score = 60
      else if ((p.landmark || '').toLowerCase().includes(needle)) score = 50
      else if (p.ward.toLowerCase() === needle) score = 30
      else {
        const ward = WARDS.find((w) => w.id === p.ward)
        if (ward && ward.name.toLowerCase().includes(needle)) score = 25
        for (const w of WARDS) if (w.name.toLowerCase().includes(needle) && w.id === p.ward) score = 40
        if (/^\d{6}$/.test(needle)) {
          const [a, b] = [Number(needle.slice(0, 2)), Number(needle.slice(2))]
          const d = Math.abs((p.lat * 100) - a - 11.5) + Math.abs((p.lng * 100) - b - 74.5)
          if (d < 6) score = Math.max(score, 20 - d * 2)
        }
      }
      return { ...p, score }
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
  void at
  return scored.slice(0, 12)
}

/* ------------------------------------------------------------- driver flow */

export function applyDriverAction({ actionId, driverId, kind, payload = {} }) {
  const existing = get('SELECT action_id FROM action_queue WHERE action_id = ?', [actionId])
  if (existing) return { ok: true, duplicate: true }
  const driver = get('SELECT * FROM drivers WHERE id = ?', [driverId])
  if (!driver) return { ok: false, error: 'unknown driver' }
  const at = payload.at ? new Date(payload.at).getTime() : Date.now()
  const truck = driver.truck_id ? get('SELECT * FROM trucks WHERE id = ?', [driver.truck_id]) : null
  const stop = payload.stop_id ? get('SELECT * FROM stops WHERE id = ?', [payload.stop_id]) : null
  const point = stop ? getPoint(stop.point_id) : payload.point_id ? getPoint(payload.point_id) : null

  return tx(() => {
    run('INSERT INTO action_queue(action_id,driver_id,kind,payload,created_at,received_at) VALUES(?,?,?,?,?,?)', [
      actionId, driverId, kind, JSON.stringify(payload), new Date(at).toISOString(), nowIso(),
    ])
    bumpVersion()
    switch (kind) {
      case 'emptied':
        return doEmptied(stop, point, at, driver, payload)
      case 'nothing_to_collect':
        return doNothing(stop, point, at, driver)
      case 'problem':
        return doProblem(stop, point, truck, at, driver, payload)
      case 'add_bin':
        return doAddBin(payload, at, driver)
      case 'arrive':
        if (stop) run('UPDATE stops SET arrived_at = ? WHERE id = ?', [new Date(at).toISOString(), stop.id])
        return { ok: true, kind }
      default:
        return { ok: false, error: `unknown action ${kind}` }
    }
  })
}

function doEmptied(stop, point, at, driver, payload) {
  if (!stop || !point) return { ok: false, error: 'stop not found' }
  const reports = reportsFor(point.id)
  const learn = onEmptied(point, reports, at, allDevices())

  run('UPDATE stops SET status = ?, updated_at = ?, action_note = ? WHERE id = ?', ['done', new Date(at).toISOString(), payload.note || '', stop.id])
  run('UPDATE collection_points SET estimated_level = 0, last_emptied_at = ? WHERE id = ?', [new Date(at).toISOString(), point.id])
  run('UPDATE collection_points SET base_fill_rate = ? WHERE id = ?', [Math.round(learn.base_fill_rate * 100) / 100, point.id])

  const predictedHours = Math.round(learn.predictedHours * 10) / 10
  run(
    'INSERT INTO prediction_log(point_id,at,predicted_level,predicted_hours,actual_hours,error_hours,outcome,note) VALUES(?,?,?,?,?,?,?,?)',
    [
      point.id,
      new Date(at).toISOString(),
      100,
      predictedHours,
      learn.actualHours == null ? null : Math.round(learn.actualHours * 10) / 10,
      learn.errorHours == null ? null : Math.round(learn.errorHours * 10) / 10,
      'emptied',
      learn.note,
    ],
  )
  logActivity('emptied', `${point.code} emptied by ${driver.name}. ${learn.note}`, driver.name)
  bumpVersion()
  return {
    ok: true,
    kind: 'emptied',
    point: point.id,
    level: 0,
    base_fill_rate: Math.round(learn.base_fill_rate * 100) / 100,
    note: learn.note,
    predictedHours,
    actualHours: learn.actualHours,
    errorHours: learn.errorHours,
    notified: reportersSince(point.id, at).length,
  }
}

function doNothing(stop, point, at, driver) {
  if (!stop || !point) return { ok: false, error: 'stop not found' }
  const learn = onNothingToCollect(point, at)
  run('UPDATE stops SET status = ?, updated_at = ?, action_note = ? WHERE id = ?', ['skipped', new Date(at).toISOString(), 'nothing to collect', stop.id])
  run('UPDATE collection_points SET base_fill_rate = ? WHERE id = ?', [Math.round(learn.base_fill_rate * 100) / 100, point.id])
  refreshEstimates(at)
  logActivity('nothing', `${point.code}: nothing to collect. ${learn.note}`, driver.name)
  bumpVersion()
  return { ok: true, kind: 'nothing_to_collect', base_fill_rate: Math.round(learn.base_fill_rate * 100) / 100, note: learn.note }
}

const PROBLEMS = ['bin_missing', 'road_blocked', 'truck_full', 'truck_breakdown']

function doProblem(stop, point, truck, at, driver, payload) {
  const problem = PROBLEMS.includes(payload.problem) ? payload.problem : 'bin_missing'
  if (stop) run('UPDATE stops SET status = ?, updated_at = ?, action_note = ? WHERE id = ?', ['problem', new Date(at).toISOString(), problem, stop.id])
  if (point && problem === 'bin_missing') run('UPDATE collection_points SET note = ? WHERE id = ?', ['reported missing by driver', point.id])

  let reRoute = null
  if (problem === 'road_blocked') reRoute = blockNearestRoad(point)
  if (problem === 'truck_full' && truck && point) reRoute = insertDumpStop(truck.id, stop?.id ?? null, at)
  if (problem === 'truck_breakdown' && truck) reRoute = truckDown(truck.id, 'driver reported breakdown')

  logActivity('problem', `${problem} at ${point?.code || 'route'}${truck ? ` on ${truck.name}` : ''}`, driver.name)
  bumpVersion()
  return { ok: true, kind: 'problem', problem, reRoute }
}

function doAddBin(payload, at, driver) {
  const lat = Number(payload.lat)
  const lng = Number(payload.lng)
  if (!isFinite(lat) || !isFinite(lng)) return { ok: false, error: 'needs a location' }
  const ward = WARDS.find((w) => lat > w.lat - 0.022 && lat < w.lat + 0.022 && lng > w.lng - 0.03 && lng < w.lng + 0.03)?.id || 'W01'
  const n = Number(get('SELECT COUNT(*) AS c FROM collection_points')?.c || 0) + 1
  const pid = `${ward}-${String(n).padStart(2, '0')}-${Math.random().toString(36).slice(2, 5)}`
  const code = `${ward}-B${String(n).padStart(2, '0')}`
  const graph = loadGraph()
  run(
    `INSERT INTO collection_points(id,code,name,landmark,lat,lng,ward,area_type,type,base_fill_rate,estimated_level,last_emptied_at,status,expected_load_kg,created_at,note,node_id)
     VALUES(?,?,?,?,?,?,?,'street','public_bin',4.5,0,NULL,'pending_approval',110,?,?,?)`,
    [pid, code, payload.name || 'New bin added by driver', payload.landmark || 'added from truck', lat, lng, ward, new Date(at).toISOString(), `added by ${driver.name}`, snapNode(graph, lat, lng).id],
  )
  logActivity('point', `Pending bin ${code} added by ${driver.name}`)
  bumpVersion()
  return { ok: true, kind: 'add_bin', point_id: pid, code }
}

function reportersSince(pointId, at) {
  return all('SELECT DISTINCT device_id FROM reports WHERE point_id = ? AND created_at > ?', [
    pointId,
    new Date(at - 864e5).toISOString(),
  ])
}

/* ------------------------------------------------- roads, trucks, dispatch */

export function blockNearestRoad(point) {
  const graph = loadGraph()
  const snap = snapNode(graph, point.lat, point.lng)
  const edges = graph.adj.get(snap.id) || []
  const open = edges.filter((e) => !e.blocked)
  if (open.length === 0) return null
  const pick = open[Math.floor(open.length / 2)]
  setEdgeBlocked(pick.to, snap.id, true)
  logActivity('road', `Blocked road ${snap.id}-${pick.to} near ${point.code}`)
  const rr = rerouteAll()
  bumpVersion()
  return { edge: [snap.id, pick.to], reroute: rr }
}

function setEdgeBlocked(a, b, blocked) {
  run('UPDATE road_edges SET blocked = ? WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)', [blocked ? 1 : 0, a, b, b, a])
  invalidateGraph()
}

export function setRoadBlocked(a, b, blocked) {
  setEdgeBlocked(a, b, blocked)
  logActivity('road', `${blocked ? 'Blocked' : 'Cleared'} road ${a}-${b}`)
  const rr = blocked ? rerouteAll() : null
  bumpVersion()
  return { ok: true, edge: { a, b, blocked: !!blocked }, reroute: rr }
}

export function allBlockedRoads() {
  return all(
    `SELECT a,b,km,name FROM road_edges WHERE blocked = 1
     UNION SELECT b,a,km,name FROM road_edges WHERE blocked = 1 AND a > b`,
  )
}

export function truckDown(truckId, reason = 'operator marked down') {
  const t = get('SELECT * FROM trucks WHERE id = ?', [truckId])
  if (!t) return { ok: false, error: 'no such truck' }
  run('UPDATE trucks SET status = ? WHERE id = ?', ['down', truckId])
  logActivity('truck', `${t.name} marked down: ${reason}`)
  const rr = rerouteAll()
  bumpVersion()
  return { ok: true, truck: t.id, reroute: rr }
}

export function truckUp(truckId) {
  run('UPDATE trucks SET status = ? WHERE id = ?', ['active', truckId])
  logActivity('truck', `Truck ${truckId} back in service`)
  bumpVersion()
  return { ok: true }
}

/** Re-dispatch every pending stop onto the trucks that are still running. */
export function rerouteAll(at = simNow()) {
  const points = allPoints()
  const yards = dumpYards()
  const trucks = allTrucks()
  const liveStops = all("SELECT * FROM stops WHERE status IN ('pending','problem')")
  if (liveStops.length === 0) return null

  const idxOf = new Map(points.map((p, i) => [p.id, i + 1]))
  const liveTrucks = trucks.filter((t) => t.status !== 'down')
  if (liveTrucks.length === 0) return { blocked: true, reason: 'no trucks running' }

  // Stops whose truck is still running stay with that truck. Stops on a broken
  // truck become orphans and are handed out by cheapest insertion.
  const keep = new Map()
  const orphan = []
  for (const s of liveStops) {
    if (liveTrucks.some((t) => t.id === s.truck_id)) {
      if (!keep.has(s.truck_id)) keep.set(s.truck_id, [])
      keep.get(s.truck_id).push(s.point_id)
    } else {
      orphan.push(s.point_id)
    }
  }
  const orphanIdx = orphan.map((p) => idxOf.get(p)).filter((x) => x != null)
  const keepers = {}
  for (const [tid, list] of keep) keepers[tid] = list.map((p) => idxOf.get(p)).filter((x) => x != null)

  const plan = redistribute({
    graph: loadGraph(),
    depot: get('SELECT * FROM places WHERE kind = ? LIMIT 1', ['depot']),
    points,
    yards,
    trucks,
    orphanIdx,
    keepers,
    doneIdx: [],
    settings: settings(),
  })
  const candById = new Map(buildCandidates(at).map((c) => [c.point_id, c]))

  return tx(() => {
    for (const s of liveStops) run('DELETE FROM stops WHERE id = ?', [s.id])
    const routeId = all('SELECT id FROM routes LIMIT 1')[0]?.id || `route-${new Date(at).toISOString().slice(0, 10)}`
    for (const r of plan.routes) {
      let order = 0
      for (const st of r.stops) {
        const pid = points[st.matrixIndex - 1]?.id
        if (!pid) continue
        order += 1
        const cand = candById.get(pid)
        run(
          'INSERT INTO stops(id,route_id,truck_id,point_id,stop_order,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
          [id('stp'), routeId, r.truck_id, pid, order, reasonFor({ ...cand, forced: cand && cand.priority >= settings().forced_threshold }), 'pending', new Date(at).toISOString()],
        )
      }
      run('UPDATE routes SET km = ?, minutes = ? WHERE truck_id = ?', [r.km, r.minutes, r.truck_id])
    }
    logActivity('route', `Re-routed ${liveStops.length} stops across ${plan.routes.length} trucks, ${orphan.length} reassigned`)
    bumpVersion()
    return { stops: liveStops.length, trucks: plan.routes.length, reassigned: orphan.length }
  })
}

function insertDumpStop(truckId, stopId, at) {
  const truck = get('SELECT * FROM trucks WHERE id = ?', [truckId])
  if (!truck) return null
  const stops = all('SELECT * FROM stops WHERE truck_id = ? ORDER BY stop_order', [truckId])
  const yard = dumpYards()[0]
  if (!yard) return null
  const after = stopId ? stops.findIndex((s) => s.id === stopId) : stops.length - 1
  const pos = after < 0 ? stops.length : after + 1
  for (let i = stops.length - 1; i >= pos; i--) run('UPDATE stops SET stop_order = ? WHERE id = ?', [i + 2, stops[i].id])
  const routeId = stops[0]?.route_id
  const pid = `yard-stop-${truckId}-${Math.random().toString(36).slice(2, 6)}`
  run(
    `INSERT INTO collection_points(id,code,name,landmark,lat,lng,ward,area_type,type,base_fill_rate,estimated_level,last_emptied_at,status,expected_load_kg,created_at,note,node_id)
     VALUES(?,?,?,?,?,?,?,'street','public_bin',0,0,?,'active',0,?,?,?)`,
    [pid, `YARD-${truckId.slice(-1)}`, yard.name, 'dump yard', yard.lat, yard.lng, 'W01', new Date(at).toISOString(), new Date(at).toISOString(), 'dump yard stop', snapNode(loadGraph(), yard.lat, yard.lng).id],
  )
  run(
    'INSERT INTO stops(id,route_id,truck_id,point_id,stop_order,reason,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [id('stp'), routeId, truckId, pid, pos + 1, 'truck full, offload here', 'pending', new Date(at).toISOString()],
  )
  logActivity('route', `Dump yard stop added to ${truck.name} at position ${pos + 1}`)
  bumpVersion()
  return { yard: yard.name, order: pos + 1 }
}

/* --------------------------------------------------------------- reporting */

export function statePayload(at = simNow()) {
  const s = settings()
  const points = allPointsIncludingPending()
  const devices = allDevices()
  const events = allEvents()
  const trucks = allTrucks()
  const drivers = allDrivers().map(({ pin, ...rest }) => rest)
  const stops = all('SELECT * FROM stops ORDER BY truck_id, stop_order')
  const recentReports = all('SELECT * FROM reports ORDER BY created_at DESC LIMIT 60')
  const candidates = buildCandidates(at)

  const perTruck = trucks.map((t) => {
    const list = stops.filter((s) => s.truck_id === t.id)
    const route = get('SELECT * FROM routes WHERE truck_id = ? ORDER BY created_at DESC LIMIT 1', [t.id])
    const done = list.filter((s) => s.status === 'done').length
    return {
      ...t,
      driver_name: drivers.find((d) => d.id === t.driver_id)?.name || null,
      stops: list.length,
      done,
      km: route?.km ?? null,
      minutes: route?.minutes ?? null,
      solver: route?.solver ?? null,
      exact: route?.exact ? 1 : 0,
      nextStop: list.find((s) => s.status === 'pending')?.id || null,
    }
  })

  const predictions = candidates.map((c) => ({ point_id: c.point_id, level: c.level, priority: c.priority }))
  const weekReports = all(
    'SELECT r.device_id, r.level, r.point_id FROM reports r WHERE r.created_at > ? ORDER BY r.created_at DESC LIMIT 4000',
    [new Date(at - 7 * 864e5).toISOString()],
  )
  const flagged = flagDevices(devices, weekReports, predictions)

  return {
    version: version(),
    serverTime: at,
    settings: s,
    wards: WARDS,
    points,
    predictions,
    trucks: perTruck,
    drivers,
    stops,
    events,
    devices: { count: devices.length, flagged },
    reports: recentReports,
    roadNodes: all('SELECT * FROM road_nodes'),
    blockedRoads: allBlockedRoads(),
    places: places(),
    pickups: all('SELECT * FROM pickups ORDER BY created_at DESC'),
    predictionLog: all('SELECT * FROM prediction_log ORDER BY id DESC LIMIT 120'),
    activity: all('SELECT * FROM activity ORDER BY id DESC LIMIT 25'),
    graph: { nodes: all('SELECT id,lat,lng,label FROM road_nodes'), edges: all('SELECT a,b,name FROM road_edges') },
    counts: {
      points: points.filter((p) => p.status === 'active').length,
      pending: points.filter((p) => p.status !== 'active').length,
      devices: devices.length,
      reports: Number(get('SELECT COUNT(*) AS c FROM reports')?.c || 0),
      stops: stops.length,
      done: stops.filter((s) => s.status === 'done').length,
      online: devices.filter((d) => at - new Date(d.last_seen).getTime() < 864e5).length,
    },
  }
}

export function savingsPayload(at = simNow()) {
  const points = allPoints()
  const plan = planRoutes({
    graph: loadGraph(),
    depot: get('SELECT * FROM places WHERE kind = ? LIMIT 1', ['depot']),
    points,
    yards: dumpYards(),
    trucks: allTrucks(),
    candidates: buildCandidates(at),
    settings: settings(),
    liveStops: all("SELECT * FROM stops WHERE status != 'done'"),
  })
  const actualKm = plan.routes.reduce((s, r) => s + r.km, 0)
  const compare = savingsCompare({
    points,
    matrix: plan.matrix,
    depotIndex: 0,
    yardIndex: dumpYards().length ? 1 + points.length : 0,
    actualKm,
    settings: settings(),
  })
  return { ...compare, actualStops: plan.selection.selected.length, totalPoints: points.length }
}

export function racePayload(at = simNow()) {
  const points = allPoints()
  const plan = planRoutes({
    graph: loadGraph(),
    depot: get('SELECT * FROM places WHERE kind = ? LIMIT 1', ['depot']),
    points,
    yards: dumpYards(),
    trucks: allTrucks(),
    candidates: buildCandidates(at),
    settings: settings(),
    liveStops: null,
  })
  const stops = plan.selection.selected.slice(0, 12).map((c) => c.i)
  return race(stops.length ? stops : [1, 2, 3], plan.matrix, 0)
}

/** Why this route: the signals behind one stop. */
export function whyPayload(pointId, at = simNow()) {
  const point = getPoint(pointId)
  if (!point) return null
  const events = allEvents()
  const devices = allDevices()
  const reports = reportsFor(pointId)
  const base = baseLevel(point, events, at)
  const blend = blendReports(base, reports, devices, at)
  const since = reportsSinceEmpty(point, reports, at)
  const cand = buildCandidates(at).find((c) => c.point_id === pointId)
  const stop = get('SELECT * FROM stops WHERE point_id = ? ORDER BY id DESC LIMIT 1', [pointId])
  const hours = point.last_emptied_at ? (at - new Date(point.last_emptied_at).getTime()) / 36e5 : 0
  return {
    point,
    base_level: Math.round(base * 10) / 10,
    final_level: Math.round(blend.level * 10) / 10,
    blend,
    hoursSinceEmpty: Math.round(hours * 10) / 10,
    base_fill_rate: point.base_fill_rate,
    areaFactor: AREA_FACTOR[point.area_type],
    eventMultiplier: activeEventMultiplier(point, events, at),
    reports: reports.slice(0, 8).map((r) => ({ ...r, trust: devices.find((d) => d.device_id === r.device_id)?.trust ?? 0.5 })),
    reportsSinceEmpty: since.length,
    priority: cand?.priority ?? 0,
    stop,
    contributions: cand
      ? [
          { label: 'estimated level', value: Math.round(cand.level * 10) / 10 },
          { label: 'hours waiting x 0.5', value: Math.round(cand.hoursWaiting * 0.5 * 10) / 10 },
          { label: 'extra reports x 5', value: cand.extraReports * 5 },
          { label: 'hospital or school bonus', value: cand.sensitiveBonus },
          { label: 'priority', value: cand.priority },
        ]
      : [],
  }
}

/* ------------------------------------------------------------------- admin */

export function upsertPoint(body) {
  const now = nowIso()
  if (body.id) {
    const fields = ['name', 'landmark', 'lat', 'lng', 'ward', 'area_type', 'type', 'base_fill_rate', 'status', 'expected_load_kg', 'note']
    const sets = fields.filter((f) => body[f] !== undefined).map((f) => `${f} = ?`).join(',')
    const vals = fields.filter((f) => body[f] !== undefined).map((f) => body[f])
    if (sets) run(`UPDATE collection_points SET ${sets} WHERE id = ?`, [...vals, body.id])
    logActivity('point', `Point ${body.code || body.id} updated`)
    bumpVersion()
    return { ok: true, id: body.id }
  }
  const n = Number(get('SELECT COUNT(*) AS c FROM collection_points')?.c || 0) + 1
  const ward = body.ward || 'W01'
  const pid = body.id || `${ward}-${String(n).padStart(2, '0')}-${Math.random().toString(36).slice(2, 5)}`
  const code = body.code || `${ward}-B${String(n).padStart(2, '0')}`
  run(
    `INSERT INTO collection_points(id,code,name,landmark,lat,lng,ward,area_type,type,base_fill_rate,estimated_level,last_emptied_at,status,expected_load_kg,created_at,note,node_id)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?)`,
    [
      pid, code, body.name || 'New collection point', body.landmark || '', Number(body.lat) || 0, Number(body.lng) || 0,
      ward, body.area_type || 'street', body.type || 'public_bin', Number(body.base_fill_rate) || 4,
      0, body.last_emptied_at || null, Number(body.expected_load_kg) || 120, now, body.note || '',
      snapNode(loadGraph(), Number(body.lat) || 0, Number(body.lng) || 0).id,
    ],
  )
  logActivity('point', `Point ${code} created`)
  bumpVersion()
  return { ok: true, id: pid, code }
}

export function approvePoint(pointId, approved, note = '') {
  const p = getPoint(pointId)
  if (!p) return { ok: false, error: 'no such point' }
  run('UPDATE collection_points SET status = ?, note = ? WHERE id = ?', [approved ? 'active' : 'rejected', note, pointId])
  logActivity('point', `${p.code} ${approved ? 'approved' : 'rejected'}`)
  bumpVersion()
  return { ok: true }
}

export function upsertEvent(body) {
  const now = nowIso()
  const exists = body.id && get('SELECT id FROM events WHERE id = ?', [body.id])
  if (exists) {
    run('UPDATE events SET name = ?, ward = ?, start = ?, end = ?, multiplier = ?, status = ? WHERE id = ?', [
      body.name, body.ward || 'all', body.start, body.end, Number(body.multiplier) || 1, body.status || 'active', body.id,
    ])
    logActivity('event', `Event ${body.name} updated`)
  } else {
    run('INSERT INTO events(id,name,ward,start,end,multiplier,status,created_at) VALUES(?,?,?,?,?,?,?,?)', [
      id('ev'), body.name, body.ward || 'all', body.start, body.end, Number(body.multiplier) || 1, body.status || 'active', now,
    ])
    logActivity('event', `Event ${body.name} created`)
  }
  refreshEstimates()
  bumpVersion()
  return { ok: true }
}

export function deleteEvent(eventId) {
  run('DELETE FROM events WHERE id = ?', [eventId])
  refreshEstimates()
  bumpVersion()
  return { ok: true }
}

export function upsertTruck(body) {
  if (body.id) {
    run('UPDATE trucks SET name = ?, plate = ?, capacity_kg = ?, status = ?, driver_id = ? WHERE id = ?', [
      body.name, body.plate, Number(body.capacity_kg) || 1000, body.status || 'active', body.driver_id || null, body.id,
    ])
  } else {
    run('INSERT INTO trucks(id,name,plate,capacity_kg,status,driver_id) VALUES(?,?,?,?,?,?)', [
      id('truck'), body.name || 'New truck', body.plate || 'TS 00 AR 0000', Number(body.capacity_kg) || 1000, 'active', body.driver_id || null,
    ])
  }
  logActivity('truck', `Truck ${body.name || body.id} saved`)
  bumpVersion()
  return { ok: true }
}

export function upsertDriver(body) {
  if (body.id) {
    run('UPDATE drivers SET name = ?, phone = ?, pin = ?, truck_id = ? WHERE id = ?', [
      body.name, body.phone, body.pin || '0000', body.truck_id || null, body.id,
    ])
  } else {
    run('INSERT INTO drivers(id,name,phone,pin,truck_id) VALUES(?,?,?,?,?)', [
      id('drv'), body.name || 'New driver', body.phone, body.pin || '0000', body.truck_id || null,
    ])
  }
  logActivity('driver', `Driver ${body.name || body.id} saved`)
  bumpVersion()
  return { ok: true }
}

export function deleteTruck(truckId) {
  run('DELETE FROM stops WHERE truck_id = ?', [truckId])
  run('DELETE FROM trucks WHERE id = ?', [truckId])
  bumpVersion()
  return { ok: true }
}

export function updateSetting(key, value) {
  setSetting(key, value)
  refreshEstimates()
  bumpVersion()
  return { ok: true }
}

export function addPickup(body) {
  const pid = id('pick')
  run('INSERT INTO pickups(id,point_id,custodian_name,phone,ward,needed_by,kind,notes,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    pid, body.point_id || null, body.custodian_name || 'Custodian', body.phone || '', body.ward || '',
    body.needed_by || new Date(simNow() + 864e5).toISOString(), body.kind || 'bulk', body.notes || '', 'open', nowIso(),
  ])
  logActivity('pickup', `Pickup request from ${body.custodian_name}`)
  bumpVersion()
  return { ok: true, id: pid }
}

export function setPickupStatus(pickupId, status) {
  run('UPDATE pickups SET status = ? WHERE id = ?', [status, pickupId])
  bumpVersion()
  return { ok: true }
}

/** Fast forward one simulated day: age the city, run a cycle, learn. */
export function fastForwardDay() {
  const current = clockOffsetMs()
  const next = current + 864e5
  setClockOffset(next)
  const at = Date.now() + next

  return tx(() => {
    refreshEstimates(at)
    const points = allPoints()
    const cands = buildCandidates(at)
    const above = cands.filter((c) => c.priority >= settings().threshold)
    let emptied = 0
    let learned = 0
    for (const p of points) {
      const cand = cands.find((c) => c.point_id === p.id)
      if (!cand || cand.priority < settings().threshold) continue
      if (Math.random() > 0.82) continue
      const learn = onEmptied(p, reportsFor(p.id), at, allDevices())
      run('UPDATE collection_points SET estimated_level = 0, last_emptied_at = ?, base_fill_rate = ? WHERE id = ?', [
        new Date(at).toISOString(), Math.round(clamp(learn.base_fill_rate, 0.4, 22) * 100) / 100, p.id,
      ])
      run('INSERT INTO prediction_log(point_id,at,predicted_level,predicted_hours,actual_hours,error_hours,outcome,note) VALUES(?,?,?,?,?,?,?,?)', [
        p.id, new Date(at).toISOString(), Math.round(cand.level), Math.round(learn.predictedHours * 10) / 10,
        learn.actualHours == null ? null : Math.round(learn.actualHours * 10) / 10,
        learn.errorHours == null ? null : Math.round(learn.errorHours * 10) / 10,
        'emptied', learn.note,
      ])
      emptied++
      learned++
    }
    logActivity('demo', `Fast forward one day. ${emptied} collections, ${learned} rate updates.`)
    bumpVersion()
    return { ok: true, at, emptied, aboveThreshold: above.length }
  })
}

/** Simulated citizen report for the demo buttons. */
export function simulateReport(overrides = {}) {
  const at = simNow()
  const points = allPoints()
  const candidates = buildCandidates(at)
  const lowest = candidates.slice().sort((a, b) => a.level - b.level)[0]
  const hottest = candidates.slice().sort((a, b) => b.level - a.level)[0]
  const point = overrides.point_id
    ? getPoint(overrides.point_id)
    : Math.random() < 0.5
      ? hottest
      : lowest
  if (!point) return { ok: false, error: 'no points' }
  const deviceId = `sim-${String(Math.floor(Math.random() * 900) + 100)}`
  const level = overrides.level || (Math.random() < 0.6 ? 'full' : 'overflowing')
  const result = addReport({
    pointId: point.id,
    deviceId,
    level,
    source: overrides.source || ['search', 'saved', 'typed', 'pin'][Math.floor(Math.random() * 4)],
  })
  return { ...result, point: { id: point.id, code: point.code, name: point.name }, device: deviceId, at }
}

export function resetData() {
  seedAll()
  return { ok: true, version: version() }
}

/**
 * What /report needs on a fresh visit: the person's saved bins, and for each one
 * whether a truck has emptied it since they last reported it.
 */
export function reportContext(deviceId, savedIds = [], at = simNow()) {
  ensureDevice(deviceId)
  const points = allPointsIncludingPending()
  const byId = new Map(points.map((p) => [p.id, p]))
  const saved = (Array.isArray(savedIds) ? savedIds : [])
    .map((pid) => byId.get(pid))
    .filter(Boolean)
    .map((p) => {
      const lastMine = get(
        'SELECT created_at, level FROM reports WHERE point_id = ? AND device_id = ? ORDER BY created_at DESC LIMIT 1',
        [p.id, deviceId],
      )
      const emptied = p.last_emptied_at && (!lastMine || new Date(p.last_emptied_at) > new Date(lastMine.created_at))
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        landmark: p.landmark,
        ward: p.ward,
        lat: p.lat,
        lng: p.lng,
        estimated_level: p.estimated_level,
        status: p.status,
        last_emptied_at: emptied ? p.last_emptied_at : null,
        last_reported_at: lastMine?.created_at || null,
        last_reported_level: lastMine?.level || null,
      }
    })

  const recent = get(
    'SELECT point_id, level, created_at FROM reports WHERE device_id = ? ORDER BY created_at DESC LIMIT 5',
    [deviceId],
  )
  const pointsByRecent = recent.map((r) => {
    const p = byId.get(r.point_id)
    const emptiedAfter = p?.last_emptied_at && new Date(p.last_emptied_at) > new Date(r.created_at)
    return {
      point_id: r.point_id,
      code: p?.code,
      name: p?.name,
      level: r.level,
      created_at: r.created_at,
      emptied_at: emptiedAfter ? p.last_emptied_at : null,
    }
  })

  return {
    device_id: deviceId,
    saved,
    notices: pointsByRecent.filter((n) => n.emptied_at),
    reportsBlocked: recent
      .map((r) => ({ point_id: r.point_id, code: byId.get(r.point_id)?.code, created_at: r.created_at }))
      .filter((r) => at - new Date(r.created_at) < (settings().report_rate_limit_minutes || 30) * 60e3),
    wards: WARDS,
    serverTime: at,
  }
}

export function authLogin({ role, phone, pin, email, password }) {
  if (role === 'driver') {
    const d = get('SELECT * FROM drivers WHERE phone = ?', [String(phone || '').trim()])
    if (!d || String(d.pin) !== String(pin || '')) return { ok: false, error: 'Phone number or PIN is not correct' }
    return { ok: true, role: 'driver', token: `${d.id}.${d.pin}`, driver: { id: d.id, name: d.name, truck_id: d.truck_id } }
  }
  const o = get('SELECT * FROM operators WHERE email = ?', [String(email || '').trim().toLowerCase()])
  if (!o || o.password !== String(password || '')) return { ok: false, error: 'Email or password is not correct' }
  return { ok: true, role: 'control', token: `${o.email}.${Buffer.from(o.password).toString('base64')}`, operator: { email: o.email, name: o.name } }
}

export function demoLogins() {
  return {
    drivers: allDrivers().map((d) => ({ phone: d.phone, pin: d.pin, name: d.name, truck_id: d.truck_id })),
    operators: allOperators(),
  }
}
function allOperators() {
  return all('SELECT email, password, name FROM operators')
}

export function stats() {
  return {
    points: Number(get('SELECT COUNT(*) AS c FROM collection_points')?.c || 0),
    reports: Number(get('SELECT COUNT(*) AS c FROM reports')?.c || 0),
    devices: Number(get('SELECT COUNT(*) AS c FROM devices')?.c || 0),
    stops: Number(get('SELECT COUNT(*) AS c FROM stops')?.c || 0),
    version: version(),
  }
}

export { getDb }