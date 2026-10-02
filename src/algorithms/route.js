// Route construction: select which points need collection, split them across
// trucks, then order each truck's stops. All pure functions.
//
// Travel cost is the road distance matrix from graph.js, so "cost" is kilometres.

export const DEFAULT_SETTINGS = {
  threshold: 70,
  forced_threshold: 90,
  cost_per_km: 12,
  shift_hours: 8,
  avg_speed_kph: 22,
  service_minutes: 6,
  fuel_price_per_litre: 105,
  co2_kg_per_litre: 2.32,
}

/** Driving + service minutes for a route of `km` covering `stops` points. */
export function routeMinutes(km, stopCount, settings = DEFAULT_SETTINGS) {
  const drive = (km / (settings.avg_speed_kph || 22)) * 60
  const service = stopCount * (settings.service_minutes || 6)
  return drive + service
}

/** Road km of a straight depot-out-and-back sequence through `idxList`. */
export function depotOutKm(idxList, matrix, depotIndex) {
  let km = 0
  let prev = depotIndex
  for (const i of idxList) {
    km += matrix.at(prev, i)
    prev = i
  }
  return km + matrix.at(prev, depotIndex)
}

/**
 * Select points for the shift.
 *  - priority >= threshold         -> candidate
 *  - priority >= forced_threshold  -> always included
 *  - ranked by priority per km of travel from depot
 *  - the 8 hour shift budget caps the rest
 */
export function selectPoints(candidates, matrix, depotIndex, settings = DEFAULT_SETTINGS) {
  const { threshold, forced_threshold: forced, shift_hours: shiftH } = settings
  const budget = shiftH * 60

  const ranked = candidates
    .filter((c) => c.priority >= threshold)
    .map((c) => {
      const km = matrix ? matrix.at(depotIndex, c.i) : 0
      return { ...c, km, ratio: c.priority / Math.max(0.5, km) }
    })
    .sort((a, b) => b.priority - a.priority || b.ratio - a.ratio)

  const forcedList = ranked.filter((c) => c.priority >= forced)
  const optional = ranked.filter((c) => c.priority < forced)

  const selected = []
  for (const c of forcedList) {
    const trial = selected.concat([c])
    if (routeMinutes(depotOutKm(trial.map((x) => x.i), matrix, depotIndex), trial.length, settings) <= budget) {
      selected.push(c)
    }
  }

  const deferred = []
  for (const c of optional) {
    const trial = selected.concat([c])
    const mins = routeMinutes(depotOutKm(trial.map((x) => x.i), matrix, depotIndex), trial.length, settings)
    if (mins <= budget) selected.push(c)
    else deferred.push(c)
  }

  const km = depotOutKm(selected.map((c) => c.i), matrix, depotIndex)
  return {
    selected,
    deferred,
    forced: forcedList.length,
    threshold,
    shiftMinutes: budget,
    budgetUsedMinutes: Math.round(routeMinutes(km, selected.length, settings)),
    km: Math.round(km * 10) / 10,
  }
}

/**
 * Angular sweep around the depot, balanced by load and capacity.
 * Contiguous angular slices hand each sector to one truck; a point that would
 * overflow its slice's capacity spills to the least loaded truck that fits.
 */
export function splitByAngle(candidates, depot, trucks) {
  const pool = (trucks.filter((t) => t.status !== 'down').length
    ? trucks.filter((t) => t.status !== 'down')
    : trucks)
  if (pool.length === 0) return { buckets: [] }

  const withAngle = candidates.map((c) => {
    const dLat = c.lat - depot.lat
    const dLng = (c.lng - depot.lng) * Math.cos((depot.lat * Math.PI) / 180)
    return { ...c, angle: (Math.atan2(dLng, dLat) * 180) / Math.PI }
  })
  withAngle.sort((a, b) => a.angle - b.angle)

  const buckets = pool.map((t) => ({ truck: t, items: [], load: 0, capacity: t.capacity_kg || 1000 }))
  const slice = 360 / buckets.length

  for (const c of withAngle) {
    const idx = Math.min(buckets.length - 1, Math.floor((((c.angle % 360) + 360) % 360) / slice))
    let target = buckets[idx]
    const w = c.load_kg || 0
    if (target.load + w > target.capacity) {
      const alt = buckets
        .filter((b) => b.load + w <= b.capacity)
        .sort((a, b) => a.load / a.capacity - b.load / b.capacity)[0]
      if (alt) target = alt
      else target = buckets.slice().sort((a, b) => a.load - b.load)[0]
    }
    target.items.push(c)
    target.load += w
  }
  return { buckets: buckets.filter((b) => b.items.length > 0) }
}

/** Nearest neighbour ordering. `idxList` are matrix indices. */
export function nearestNeighbour(idxList, matrix, startIndex, endIndex = startIndex) {
  const remaining = idxList.filter((i) => i !== startIndex && i !== endIndex)
  const seq = [startIndex]
  let cur = startIndex
  while (remaining.length) {
    let bestAt = 0
    let bestD = Infinity
    for (let k = 0; k < remaining.length; k++) {
      const d = matrix.at(cur, remaining[k])
      if (d < bestD) {
        bestD = d
        bestAt = k
      }
    }
    cur = remaining.splice(bestAt, 1)[0]
    seq.push(cur)
  }
  seq.push(endIndex)
  return seq
}

/** Length in km of a sequence on the matrix. */
export function seqLength(seq, matrix) {
  let km = 0
  for (let i = 0; i + 1 < seq.length; i++) km += matrix.at(seq[i], seq[i + 1])
  return km
}

/**
 * 2-opt: reverse segments while it shortens the tour.
 * Complexity O(passes * n^2). Distance lookups are O(1) on the matrix.
 */
export function twoOpt(seq, matrix, passes = 60) {
  let best = seq.slice()
  let changed = true
  let p = 0
  while (changed && p < passes) {
    changed = false
    p++
    for (let i = 1; i + 1 < best.length - 1; i++) {
      for (let k = i + 1; k + 1 <= best.length - 1; k++) {
        const a = best[i]
        const b = best[i + 1]
        const c = best[k]
        const d = best[k + 1]
        const cur = matrix.at(a, b) + matrix.at(c, d)
        const alt = matrix.at(a, c) + matrix.at(b, d)
        if (alt + 1e-9 < cur) {
          const rev = best.slice(i + 1, k + 1).reverse()
          best = best.slice(0, i + 1).concat(rev, best.slice(k + 1))
          changed = true
        }
      }
    }
  }
  return { seq: best, km: seqLength(best, matrix) }
}

export const HK_MAX_STOPS = 12

/**
 * Held-Karp exact TSP over `stops` (matrix indices), depot in and out.
 * dp[mask][j] = cheapest way to leave the depot, cover `mask`, end at j.
 * Complexity O(n^2 * 2^n) time and O(n * 2^n) memory, so it refuses to run
 * above HK_MAX_STOPS instead of freezing the browser.
 */
export function heldKarp(stops, matrix, startIndex, endIndex = startIndex) {
  const n = stops.length
  if (n === 0) return { seq: [startIndex, endIndex], km: 0, states: 1, ok: true, exact: true }
  if (n === 1) return { seq: [startIndex, stops[0], endIndex], km: seqLength([startIndex, stops[0], endIndex], matrix), states: 1, ok: true, exact: true }
  if (n > HK_MAX_STOPS) return { seq: null, km: Infinity, states: 0, ok: false, exact: false }

  const FULL = (1 << n) - 1
  const key = (mask, j) => mask * n + j
  const dp = new Float64Array((FULL + 1) * n).fill(Infinity)
  const parent = new Int32Array((FULL + 1) * n).fill(-1)
  let states = 0

  for (let j = 0; j < n; j++) dp[key(1 << j, j)] = matrix.at(startIndex, stops[j])

  for (let mask = 1; mask <= FULL; mask++) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue
      const cur = dp[key(mask, j)]
      if (cur === Infinity) continue
      states++
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue
        const nm = mask | (1 << k)
        const v = cur + matrix.at(stops[j], stops[k])
        if (v < dp[key(nm, k)]) {
          dp[key(nm, k)] = v
          parent[key(nm, k)] = j
        }
      }
    }
  }

  let best = Infinity
  let bestLast = -1
  for (let j = 0; j < n; j++) {
    const v = dp[key(FULL, j)] + matrix.at(stops[j], endIndex)
    if (v < best) {
      best = v
      bestLast = j
    }
  }
  if (bestLast < 0 || !isFinite(best)) return { seq: null, km: Infinity, states, ok: false, exact: false }

  const seq = [startIndex]
  let mask = FULL
  let j = bestLast
  while (j >= 0) {
    seq.push(stops[j])
    const p = parent[key(mask, j)]
    mask ^= 1 << j
    j = p
  }
  seq.reverse()
  seq.push(endIndex)
  return { seq, km: best, states, ok: true, exact: true }
}

/**
 * Cheapest single insertion of one new point into an existing sequence.
 * O(n) scan of positions, O(1) lookups.
 */
export function cheapestInsertion(seq, itemIndex, matrix) {
  let bestAt = seq.length - 1
  let bestKm = Infinity
  let bestSeq = seq.concat([itemIndex])
  for (let i = 0; i + 1 < seq.length; i++) {
    const delta = matrix.at(seq[i], itemIndex) + matrix.at(itemIndex, seq[i + 1]) - matrix.at(seq[i], seq[i + 1])
    if (delta < bestKm) {
      bestKm = delta
      bestAt = i + 1
    }
  }
  bestSeq = seq.slice()
  bestSeq.splice(bestAt, 0, itemIndex)
  return { seq: bestSeq, addedKm: bestKm, km: seqLength(bestSeq, matrix) }
}

/**
 * Insert dump-yard stops so no leg carries more than capacityKg.
 * Greedy: drop a yard right before the stop that would overflow the bed.
 */
export function applyCapacity(seq, matrix, startIndex, endIndex, loadOf, capacityKg, yardIndex) {
  const stops = seq.filter((i) => i !== startIndex && i !== endIndex)
  const total = stops.reduce((s, i) => s + (loadOf(i) || 0), 0)
  if (stops.length === 0 || total <= capacityKg) {
    return { seq, km: seqLength(seq, matrix), inserted: [] }
  }
  const out = [startIndex]
  const inserted = []
  let run = 0
  for (const stop of stops) {
    const load = loadOf(stop) || 0
    if (run > 0 && run + load > capacityKg) {
      out.push(yardIndex)
      inserted.push(yardIndex)
      run = 0
    }
    out.push(stop)
    run += load
  }
  out.push(endIndex)
  return { seq: out, km: seqLength(out, matrix), inserted }
}