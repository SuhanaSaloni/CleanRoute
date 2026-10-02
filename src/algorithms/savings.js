// Savings against a fixed route that visits every point every day, plus the
// head-to-head benchmark used by the Algorithm Race panel.

import { DEFAULT_SETTINGS, nearestNeighbour, seqLength, twoOpt, heldKarp, HK_MAX_STOPS } from './route.js'

/**
 * Fixed route: every point in ward+code order, every day.
 * The yard is not used because a fixed route assumes one empty truck per day.
 */
export function fixedRoute(points, matrix, depotIndex, yardIndex) {
  const idx = points.map((p, i) => i).sort((a, b) => (points[a].ward + points[a].code < points[b].ward + points[b].code ? -1 : 1))
  const shifted = idx.map((i) => i + 1) // matrix index 0 is the depot
  const seq = [depotIndex].concat(shifted, [yardIndex])
  return { seq, km: seqLength(seq, matrix) }
}

/** Monetary and CO2 cost of a distance. */
export function costOfKm(km, settings = DEFAULT_SETTINGS) {
  const fuelPerKm = 1 / (settings.avg_speed_kph || 22) * 2.8 // ~2.8 km per litre at low speeds
  const litres = km * fuelPerKm
  return {
    km: Math.round(km * 10) / 10,
    rupees: Math.round(km * (settings.cost_per_km || 12) + litres * (settings.fuel_price_per_litre || 105)),
    litres: Math.round(litres * 100) / 100,
    co2: Math.round(litres * (settings.co2_kg_per_litre || 2.32) * 10) / 10,
  }
}

/** Full comparison used by the savings dashboard. */
export function savingsCompare({ points, matrix, depotIndex, yardIndex, actualKm, settings = DEFAULT_SETTINGS }) {
  const fixed = fixedRoute(points, matrix, depotIndex, yardIndex)
  const a = costOfKm(actualKm, settings)
  const f = costOfKm(fixed.km, settings)
  return {
    cleanroute: a,
    fixed: f,
    savedKm: Math.round((f.km - a.km) * 10) / 10,
    savedRupees: f.rupees - a.rupees,
    savedCo2: Math.round((f.co2 - a.co2) * 10) / 10,
    savedPct: f.km > 0 ? Math.round(((f.km - a.km) / f.km) * 1000) / 10 : 0,
  }
}

/**
 * Algorithm Race. Same stops, three solvers, measured with a clock.
 * Returns distance, runtime ms, percent above the exact optimum, and state count.
 */
export function race(stops, matrix, depotIndex) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  const t0 = now()
  const nn = nearestNeighbour(stops, matrix, depotIndex)
  const nnSeq = apply(nn)
  const nnMs = now() - t0

  const t1 = now()
  const opt = twoOpt(nn, matrix)
  const t1Ms = now() - t1

  const t2 = now()
  const hk = heldKarp(stops, matrix, depotIndex)
  const hkMs = now() - t2

  function apply(seq) {
    return seqLength(seq, matrix)
  }

  const best = hk.ok ? hk.km : Math.min(nnSeq, opt.km)
  const rows = [
    { name: 'Nearest neighbour', km: nnSeq, ms: nnMs, states: stops.length ** 2, complexity: 'O(n^2)', ok: true },
    { name: 'Nearest neighbour + 2-opt', km: opt.km, ms: t1Ms, states: stops.length ** 2 * 12, complexity: 'O(n^2)', ok: true },
    {
      name: 'Held-Karp (exact)',
      km: hk.ok ? hk.km : null,
      ms: hkMs,
      states: hk.states,
      complexity: 'O(n^2 2^n)',
      ok: hk.ok,
      note: hk.ok ? null : `refused above ${HK_MAX_STOPS} stops`,
    },
  ]
  for (const r of rows) {
    r.pctAbove = r.km == null || best <= 0 ? null : Math.round(((r.km - best) / best) * 1000) / 10
  }
  return { rows, stops: stops.length, optimalKm: Math.round(best * 100) / 100 }
}

/** Growth curve of solver cost vs stop count, for the runtime chart. */
export function raceCurve(maxStops = 18, matrix, depotIndex) {
  const out = []
  for (let n = 2; n <= maxStops; n++) {
    const stops = []
    for (let i = 0; i < n; i++) stops.push(((i * 7 + 3) % 38) + 1)
    const unique = [...new Set(stops)]
    const row = { n: unique.length, nn: null, twoopt: null, hk: null, hkSkipped: unique.length > HK_MAX_STOPS }
    const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
    let a = clock()
    const nnSeq = seqLength(nearestNeighbour(unique, matrix, depotIndex), matrix)
    row.nn = round3(clock() - a)
    row.nnKm = round3(nnSeq)
    a = clock()
    const to = twoOpt(nearestNeighbour(unique, matrix, depotIndex), matrix)
    row.twoopt = round3(clock() - a)
    row.twooptKm = round3(to.km)
    if (unique.length <= HK_MAX_STOPS) {
      a = clock()
      const hk = heldKarp(unique, matrix, depotIndex)
      row.hk = round3(clock() - a)
      row.hkKm = hk.ok ? round3(hk.km) : null
    }
    out.push(row)
  }
  return out
}

function round3(v) {
  return Math.round(v * 1000) / 1000
}