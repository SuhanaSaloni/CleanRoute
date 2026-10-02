// Dispatch orchestration: turn the live database into per-truck stop lists,
// and re-dispatch when a road is blocked or a truck goes down.
// Pure functions. The server owns persistence, this file owns decisions.

import { buildMetric } from './graph.js'
import {
  DEFAULT_SETTINGS,
  selectPoints,
  splitByAngle,
  nearestNeighbour,
  seqLength,
  twoOpt,
  heldKarp,
  cheapestInsertion,
  applyCapacity,
  routeMinutes,
} from './route.js'

/** Reason line the driver reads on the stop card. */
export function reasonFor(candidate) {
  const bits = [`predicted ${Math.round(candidate.level)}%`]
  if (candidate.extraReports > 0) bits.push(`${candidate.extraReports} report${candidate.extraReports > 1 ? 's' : ''}`)
  if (candidate.sensitiveBonus) bits.push('hospital or school')
  if (candidate.forced) bits.push('over forced threshold')
  return bits.join(' plus ')
}

/** Order one truck's stops: NN, then 2-opt, then the exact solver when small. */
export function orderStops(stopIdxs, matrix, startIndex, endIndex, yardIndex, loadOf, truck, settings = DEFAULT_SETTINGS) {
  const nn = nearestNeighbour(stopIdxs, matrix, startIndex, endIndex)
  let seq = twoOpt(nn, matrix).seq
  let exact = false
  let solver = '2-opt'

  if (stopIdxs.length <= 12) {
    const hk = heldKarp(stopIdxs, matrix, startIndex, endIndex)
    if (hk.ok && hk.km <= seqLength(seq, matrix) + 1e-9) {
      seq = hk.seq
      exact = true
      solver = 'held-karp'
    }
  }
  const cap = applyCapacity(seq, matrix, startIndex, endIndex, loadOf, Number(truck?.capacity_kg) || 1000, yardIndex)
  return { ...cap, exact, solver }
}

function stopIdxsOf(seq, startIndex, endIndex, yardIndex) {
  return seq.filter((i) => i !== startIndex && i !== endIndex && i !== yardIndex)
}

/**
 * Build today's plan.
 * Place order is [depot, ...points, ...yards] so index 0 is the depot and
 * index 1 + n is the first dump yard.
 */
export function planRoutes({
  graph,
  depot,
  points,
  yards,
  trucks,
  candidates,
  settings = DEFAULT_SETTINGS,
  liveStops = null,
}) {
  const places = [depot, ...points, ...yards]
  const matrix = buildMetric(graph, places)
  const yardIndex = yards.length ? 1 + points.length : -1
  const loadOf = (i) => {
    const p = points[i - 1]
    return p ? Number(p.expected_load_kg) || 120 : 0
  }
  const activeTrucks = trucks.filter((t) => t.status !== 'down')
  const selection = selectPoints(candidates, matrix, 0, settings)

  const forcedIds = new Set(
    candidates.filter((c) => c.priority >= settings.forced_threshold).map((c) => c.point_id),
  )

  let buckets
  if (liveStops && liveStops.length) {
    buckets = carryForward(liveStops, points, activeTrucks)
  }
  if (!buckets) {
    buckets = splitByAngle(selection.selected, depot, activeTrucks).buckets
  }

  const assigned = new Set()
  for (const b of buckets) for (const it of b.items) assigned.add(it.point_id)
  // Anything the forward pass chose but no bucket took.
  for (const c of selection.selected) {
    if (assigned.has(c.point_id)) continue
    assigned.add(c.point_id)
    const target = buckets
      .slice()
      .sort((a, b) => a.items.length - b.items.length)[0]
    if (target) target.items.push(c)
  }

  const routes = []
  for (const bucket of buckets) {
    const truck = bucket.truck
    const carry = bucket.carry || []
    const stopIdxs = bucket.items.map((it) => it.i)
    const ordered = orderStops(stopIdxs, matrix, 0, 0, yardIndex, loadOf, truck, settings)
    const finished = carry.filter((s) => s.status === 'done')
    const stops = [
      ...finished.map((s) => ({ i: s.i, status: 'done' })),
      ...stopIdxsOf(ordered.seq, 0, 0, yardIndex).map((i) => ({ i, status: 'pending' })),
    ]
    const km = seqLength(ordered.seq, matrix)
    const mins = routeMinutes(km, stops.filter((s) => s.status !== 'done').length, settings)

    routes.push({
      truck_id: truck.id,
      stops: stops.map((s, order) => ({
        matrixIndex: s.i,
        order: order + 1,
        status: s.status || 'pending',
        carriedFrom: s.stop_id ? s.stop_id : null,
      })),
      seq: ordered.seq,
      km: Math.round(km * 10) / 10,
      minutes: Math.round(mins),
      withinShift: mins <= settings.shift_hours * 60,
      exact: ordered.exact,
      solver: ordered.solver,
      yardVisits: ordered.inserted.length,
      newCount: stopIdxs.length,
      forcedCount: stopIdxs.filter((i) => forcedIds.has(points[i - 1]?.id)).length,
    })
  }

  return { selection, routes, matrix, places, points, yardIndex, loadOf }
}

/** Reuse in-progress stops so a regenerate does not restart everyone's day. */
function carryForward(liveStops, points, trucks) {
  const pointIndex = new Map(points.map((p, i) => [p.id, i + 1]))
  const byTruck = new Map()
  for (const s of liveStops) {
    if (!byTruck.has(s.truck_id)) byTruck.set(s.truck_id, [])
    const i = pointIndex.get(s.point_id)
    if (i == null) continue
    byTruck.get(s.truck_id).push({ i, status: s.status, stop_id: s.id })
  }
  const out = []
  for (const t of trucks) {
    const items = byTruck.get(t.id)
    if (!items || items.length === 0) continue
    out.push({ truck: t, items: items.filter((x) => x.status !== 'done'), carry: items.filter((x) => x.status === 'done') })
  }
  return out.length ? out : null
}

/**
 * Insert one newly urgent point into the cheapest position across all trucks.
 * `routes` must already exclude completed stops.
 */
export function insertUrgent(routes, matrix, newIndex, yardIndex, loadOf, trucks) {
  let best = null
  for (const r of routes) {
    const truck = trucks.find((t) => t.id === r.truck_id)
    const cand = cheapestInsertion(r.seq, newIndex, matrix)
    const cap = applyCapacity(
      cand.seq,
      matrix,
      r.seq[0],
      r.seq[r.seq.length - 1],
      loadOf,
      Number(truck?.capacity_kg) || 1000,
      yardIndex,
    )
    if (!best || cap.km < best.km) {
      best = { truck_id: r.truck_id, seq: cap.seq, km: cap.km, addedKm: Math.round((cap.km - r.km) * 10) / 10, inserted: cap.inserted }
    }
  }
  return best
}

/**
 * Redistribute stops after a breakdown or a blocked road.
 * Orphan stops are handed to the least loaded live truck by cheapest insertion,
 * then every truck's remaining stops are re-ordered.
 */
export function redistribute({ graph, depot, points, yards, trucks, orphanIdx, keepers = {}, doneIdx = [], settings = DEFAULT_SETTINGS }) {
  const places = [depot, ...points, ...yards]
  const matrix = buildMetric(graph, places)
  const yardIndex = yards.length ? 1 + points.length : -1
  const loadOf = (i) => {
    const p = points[i - 1]
    return p ? Number(p.expected_load_kg) || 120 : 0
  }
  const live = trucks.filter((t) => t.status !== 'down')
  const buckets = Object.fromEntries(live.map((t) => [t.id, (keepers[t.id] || []).slice()]))
  for (const t of live) if (!buckets[t.id]) buckets[t.id] = doneIdx.slice()

  for (const i of orphanIdx) {
    const owner = cheapestOwner(buckets, i, matrix, live)
    buckets[owner].push(i)
  }

  const routes = []
  for (const t of live) {
    const stopIdxs = buckets[t.id] || []
    if (stopIdxs.length === 0) continue
    const ordered = orderStops(stopIdxs, matrix, 0, 0, yardIndex, loadOf, t, settings)
    const km = seqLength(ordered.seq, matrix)
    routes.push({
      truck_id: t.id,
      stops: ordered.seq
        .filter((i) => i !== 0 && i !== yardIndex)
        .map((i, order) => ({ matrixIndex: i, order: order + 1, status: 'pending' })),
      seq: ordered.seq,
      km: Math.round(km * 10) / 10,
      minutes: Math.round(routeMinutes(km, stopIdxs.length, settings)),
      reassigned: orphanIdx.filter((i) => buckets[t.id].includes(i)).length,
      yardVisits: ordered.inserted.length,
    })
  }
  return { routes, matrix }
}

/** Which bucket grows cheapest if it takes `itemIndex`. */
function cheapestOwner(buckets, itemIndex, matrix, trucks) {
  let best = null
  let bestAdd = Infinity
  for (const t of trucks) {
    const list = buckets[t.id]
    let add = matrix.at(0, itemIndex)
    let prev = 0
    for (const i of list) {
      add = Math.min(add, matrix.at(prev, itemIndex) - matrix.at(prev, i))
      prev = i
    }
    if (list.length) add = Math.min(add, matrix.at(prev, itemIndex) - matrix.at(prev, 0))
    if (add < bestAdd) {
      bestAdd = add
      best = t.id
    }
  }
  return best
}

export { DEFAULT_SETTINGS }