// Fill estimate, report weighting and priority. Pure functions.
//
// level = base_fill_rate x hours_since_emptied x area_factor x weekday_factor
//         x active_event_multiplier, capped at 100
// then blended with trust-weighted recent citizen reports under a hard cap:
// a single new device may move the estimate by at most 15 points.

export const LEVEL_TO_PCT = { empty: 0, half: 50, full: 100, overflowing: 112 }
export const PCT_TO_LEVEL = (p) => (p >= 100 ? 'full' : p >= 45 ? 'half' : 'empty')

export const SOURCE_BONUS = { saved: 1.0, typed: 0.9, search: 0.8, pin: 0.7, gps: 0.6 }
export const SOURCE_LIST = Object.keys(SOURCE_BONUS)

/** Multiplier by ward character. Markets fill fast, residential slower. */
export const AREA_FACTOR = {
  market: 1.35,
  commercial: 1.2,
  hospital: 1.15,
  school: 1.0,
  residential: 1.0,
  street: 0.85,
}

/** Mon 0 .. Sun 6. Saturday market spillover, Sunday quiet. */
export const WEEKDAY_FACTOR = [0.95, 1.0, 1.0, 1.0, 1.05, 1.1, 0.85]

export const REPORT_HALFLIFE_HOURS = 6
export const REPORT_WINDOW_HOURS = 24
export const NEW_DEVICE_CAP = 15
export const AGREEMENT_MULTIPLIER = 1.5
export const AGREEMENT_MIN_DEVICES = 2

/** exp decay on report age. weight *= 0.5^(ageHours / halflife) */
export function recencyDecay(ageHours, halflife = REPORT_HALFLIFE_HOURS) {
  if (ageHours <= 0) return 1
  return Math.pow(0.5, ageHours / halflife)
}

/** Weight of one report: trust x source bonus x recency decay. */
export function reportWeight(report, trust = 0.5, now = Date.now()) {
  const ageH = (now - new Date(report.created_at).getTime()) / 36e5
  if (ageH > REPORT_WINDOW_HOURS) return 0
  const bonus = SOURCE_BONUS[report.source] ?? 0.7
  return (trust ?? 0.5) * bonus * recencyDecay(ageH)
}

/** Distinct devices agreeing on one level inside the window. */
export function agreementCount(reports, level, now = Date.now()) {
  const devs = new Set()
  for (const r of reports) {
    if (r.level !== level) continue
    if ((now - new Date(r.created_at).getTime()) / 36e5 > REPORT_WINDOW_HOURS) continue
    devs.add(r.device_id)
  }
  return devs.size
}

/** Highest active event multiplier whose ward/time window covers this point. */
export function activeEventMultiplier(point, events, at = Date.now()) {
  let m = 1
  for (const ev of events || []) {
    if (ev.status === 'inactive') continue
    if (ev.ward && ev.ward !== 'all' && ev.ward !== point.ward) continue
    const s = new Date(ev.start).getTime()
    const e = new Date(ev.end).getTime()
    if (at < s || at > e) continue
    m = Math.max(m, Number(ev.multiplier) || 1)
  }
  return m
}

/** Prediction from history only, before any report blending. */
export function baseLevel(point, events, at = Date.now()) {
  const hours = hoursSinceEmptied(point, at)
  if (hours <= 0) return 0
  const area = AREA_FACTOR[point.area_type] ?? 1
  const day = WEEKDAY_FACTOR[new Date(at).getDay()]
  const ev = activeEventMultiplier(point, events, at)
  return Math.min(100, point.base_fill_rate * hours * area * day * ev)
}

/**
/**
 * Blend trust-weighted reports into the prediction.
 *
 * Each device's influence is combined with a noisy-OR, so agreement from more
 * devices pulls the estimate closer to what they report without ever
 * overshooting it. Each individual device is then capped: no single device,
 * and least of all a brand new one, can move the estimate more than
 * NEW_DEVICE_CAP points on its own.
 *
 * Never rejects a report on location grounds.
 */
export function blendReports(base, reports, devices, now = Date.now()) {
  const trustOf = (id) => {
    const d = devices.find((x) => x.device_id === id)
    return d ? Number(d.trust) : 0.5
  }
  const live = (reports || []).filter(
    (r) =>
      (now - new Date(r.created_at).getTime()) / 36e5 <= REPORT_WINDOW_HOURS &&
      new Date(r.created_at).getTime() <= now,
  )
  const empty = { level: base, base, target: base, weight: 0, agree: 0, reports: 0, devices: 0, capApplied: false }
  if (live.length === 0) return empty

  // One entry per device per level, weights summed.
  const groups = new Map()
  for (const r of live) {
    const w = reportWeight(r, trustOf(r.device_id), now)
    if (w <= 0) continue
    const key = `${r.device_id}|${r.level}`
    const g = groups.get(key)
    if (g) g.w += w
    else groups.set(key, { device: r.device_id, level: r.level, w })
  }
  if (groups.size === 0) return empty

  const byLevel = new Map()
  for (const g of groups.values()) byLevel.set(g.level, (byLevel.get(g.level) || 0) + g.w)
  let winning = 'empty'
  let bestW = -1
  for (const [lv, w] of byLevel) {
    if (w > bestW) {
      bestW = w
      winning = lv
    }
  }

  const winners = [...groups.values()].filter((g) => g.level === winning)
  const agree = winners.length
  const mult = agree >= AGREEMENT_MIN_DEVICES ? AGREEMENT_MULTIPLIER : 1
  const target = LEVEL_TO_PCT[winning] ?? 50
  const gap = target - base

  // Confidence per device, combined with noisy-OR, each capped at 15 points.
  const raw = winners.map((g) => Math.min(0.95, g.w * mult))
  const capped = raw.map((c, i) => {
    if (Math.abs(gap) < 1e-9) return c
    const rest = raw.reduce((p, v, j) => (j === i ? p : p * (1 - v)), 1)
    const room = 1 - rest
    if (room <= 1e-9) return c
    return Math.min(c, NEW_DEVICE_CAP / Math.abs(gap) / room)
  })
  const conf = 1 - capped.reduce((p, v) => p * (1 - v), 1)

  const level = Math.max(0, Math.min(100, base + gap * conf))
  return {
    level,
    base: Math.round(base * 10) / 10,
    target,
    weight: Math.round(conf * 1000) / 1000,
    agree,
    reports: live.length,
    devices: agree,
    capApplied: capped.some((v, i) => v < raw[i] - 1e-9),
    reportDelta: Math.round((level - base) * 10) / 10,
    contributors: winners.map((g, i) => ({
      device_id: g.device_id,
      weight: Math.round(g.w * 1000) / 1000,
      confidence: Math.round(capped[i] * 1000) / 1000,
      capped: capped[i] < raw[i] - 1e-9,
    })),
  }
}



/** Full estimate for one point. */
export function estimateLevel(point, reports, devices, events, at = Date.now()) {
  return blendReports(baseLevel(point, events, at), reports, devices, at).level
}

/**
 * Hours since the point was last emptied. A point that was never emptied has no
 * history to trust, so it is assumed to be one shift old.
 */
export function hoursSinceEmptied(point, at = Date.now(), unknownHours = 12) {
  if (!point.last_emptied_at) return unknownHours
  return Math.max(0, (at - new Date(point.last_emptied_at).getTime()) / 36e5)
}

/** Reports for a point newer than the last emptied moment. */
export function reportsSinceEmpty(point, reports, at = Date.now()) {
  const since = point.last_emptied_at ? new Date(point.last_emptied_at).getTime() : 0
  return reports.filter((r) => new Date(r.created_at).getTime() > since && new Date(r.created_at).getTime() <= at)
}

export const HOURS_WAITING_WEIGHT = 0.5
export const PER_EXTRA_REPORT = 5
export const SENSITIVE_BONUS = 15

export function isSensitive(point) {
  return point.area_type === 'hospital' || point.area_type === 'school'
}

/**
 * priority = level + hours_waiting x 0.5 + 5 per extra report + 15 if near hospital/school
 * "Extra" means reports beyond the first one.
 */
export function priorityOf(point, level, reports, now = Date.now()) {
  const extra = Math.max(0, reports.length - 1)
  const sensitive = isSensitive(point) ? SENSITIVE_BONUS : 0
  const age = Math.min(48, hoursSinceEmptied(point, now))
  return {
    priority: level + age * HOURS_WAITING_WEIGHT + extra * PER_EXTRA_REPORT + sensitive,
    level,
    hoursWaiting: age,
    extraReports: extra,
    sensitiveBonus: sensitive,
  }
}
