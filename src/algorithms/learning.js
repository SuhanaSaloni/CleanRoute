// The learning loop. It learns from exactly two signals:
//   1. the driver's Emptied tap (the only thing a driver ever records)
//   2. public citizen reports
//
// base_fill_rate updates by exponential moving average (alpha 0.3).
//   "Nothing to collect"          -> rate * 0.90
//   3+ "Overflowing" before a truck arrives -> rate * 1.15
// Device trust moves +0.05 when a device agrees with other devices or with the
// prediction, -0.05 when it contradicts all of them.

export const EMA_ALPHA = 0.3
export const NOTHING_TO_COLLECT_FACTOR = 0.9
export const OVERFLOW_FACTOR = 1.15
export const OVERFLOW_TRIGGER = 3
export const TRUST_STEP = 0.05
export const TRUST_MIN = 0.05
export const TRUST_MAX = 0.95

export const FILL_RATE_BOUNDS = [0.4, 22]

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

/** Exponential moving average. new = old + alpha * (observed - old) */
export function ema(oldValue, observed, alpha = EMA_ALPHA) {
  return oldValue + alpha * (observed - oldValue)
}

/** Hours from an emptied tap to the first "full" report on that point. */
export function timeToFull(point, reports, at = Date.now()) {
  if (!point.last_emptied_at) return null
  const t0 = new Date(point.last_emptied_at).getTime()
  const full = reports
    .filter((r) => r.level === 'full' || r.level === 'overflowing')
    .filter((r) => new Date(r.created_at).getTime() > t0)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]
  if (!full) return null
  return (new Date(full.created_at).getTime() - t0) / 36e5
}

/**
 * Apply an Emptied tap. Returns { base_fill_rate, note, predictedHours,
 * actualHours, errorHours } and never throws.
 */
export function onEmptied(point, reports, now = Date.now(), devices = []) {
  const since = point.last_emptied_at ? new Date(point.last_emptied_at).getTime() : 0
  const after = reports.filter((r) => new Date(r.created_at).getTime() > since)
  const overflow = after.filter((r) => r.level === 'overflowing').length
  const firstFull = after
    .filter((r) => r.level === 'full' || r.level === 'overflowing')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]

  const emptyGap = since ? (now - since) / 36e5 : null
  const overflowPunish = overflow >= OVERFLOW_TRIGGER
  let rate = point.base_fill_rate
  let note = 'no signal, rate unchanged'

  if (emptyGap != null && emptyGap > 0.5) {
    // Fill the observed rate from the gap, but back off for unreported overflow.
    const observed = 100 / emptyGap
    rate = ema(rate, clamp(observed, 0.2, 40))
    note = `emptied after ${emptyGap.toFixed(1)}h, implied ${observed.toFixed(1)}%/h, EMA applied`
  }
  if (overflowPunish) {
    rate = rate * OVERFLOW_FACTOR
    note = `${overflow} overflowing reports before arrival, rate +15%`
  }

  const predictedHours = 100 / Math.max(0.01, point.base_fill_rate)
  const actualHours = firstFull ? (new Date(firstFull.created_at).getTime() - since) / 36e5 : null

  const trustUpdates = after.length
    ? devices.map((d) => ({ device_id: d.device_id, trust: d.trust }))
    : []

  return {
    base_fill_rate: clamp(rate, FILL_RATE_BOUNDS[0], FILL_RATE_BOUNDS[1]),
    note,
    gapHours: emptyGap,
    overflowReports: overflow,
    predictedHours,
    actualHours,
    errorHours: actualHours == null ? null : actualHours - predictedHours,
    trustUpdates,
  }
}

/** "Nothing to collect" -> this point fills more slowly than we thought. */
export function onNothingToCollect(point, now = Date.now()) {
  const gap = point.last_emptied_at ? (now - new Date(point.last_emptied_at).getTime()) / 36e5 : null
  const suggested = gap && gap > 0.5 ? clamp(100 / gap * NOTHING_TO_COLLECT_FACTOR, FILL_RATE_BOUNDS[0], FILL_RATE_BOUNDS[1]) : null
  return {
    base_fill_rate: clamp(point.base_fill_rate * NOTHING_TO_COLLECT_FACTOR, FILL_RATE_BOUNDS[0], FILL_RATE_BOUNDS[1]),
    note: `nothing to collect, rate -10%${suggested ? `, implied ${suggested.toFixed(1)}%/h` : ''}`,
  }
}

/**
 * Trust update for one device's latest report.
 * +0.05 when it agrees with another device or with the prediction,
 * -0.05 when it contradicts every other report and the prediction.
 */
export function trustAfterReport(device, report, otherReports, predictedLevel) {
  const target = { empty: 0, half: 50, full: 100, overflowing: 110 }[report.level] ?? 50
  const others = otherReports.filter((r) => r.device_id !== device.device_id)
  const agreesWithDevice = others.some((r) => r.level === report.level)
  const agreesWithModel =
    target >= (predictedLevel - 15) * 0.85 && target <= predictedLevel + 15 * 0.85
  let trust = device.trust
  let why = 'no other signal, trust unchanged'

  if (agreesWithDevice) {
    trust += TRUST_STEP
    why = 'agrees with another device'
  } else if (agreesWithModel) {
    trust += TRUST_STEP
    why = 'agrees with the prediction'
  } else if (others.length > 0) {
    trust -= TRUST_STEP
    why = 'contradicts every other report'
  }
  return { trust: clamp(trust, TRUST_MIN, TRUST_MAX), why }
}

/**
 * Flagged devices for the operator panel: unreliable or spamming.
 * Never blocked, just surfaced.
 */
export function flagDevices(devices, reports, predictions) {
  const out = []
  const now = Date.now()
  for (const d of devices) {
    const mine = reports.filter((r) => r.device_id === d.device_id && now - new Date(r.created_at) < 7 * 864e5)
    if (mine.length === 0) continue
    let wrong = 0
    for (const r of mine) {
      const p = predictions.find((x) => x.point_id === r.point_id)
      if (!p) continue
      const target = { empty: 0, half: 50, full: 100, overflowing: 110 }[r.level] ?? 50
      if (Math.abs(target - p.level) > 35) wrong++
    }
    const wrongRate = wrong / mine.length
    if (d.trust <= 0.2 || wrongRate >= 0.6) {
      out.push({
        device_id: d.device_id,
        trust: d.trust,
        reports: mine.length,
        wrong: wrong,
        wrongRate: Math.round(wrongRate * 100),
        reason: d.trust <= 0.2 ? 'trust at floor' : `${Math.round(wrongRate * 100)}% far from prediction`,
      })
    }
  }
  return out.sort((a, b) => a.trust - b.trust)
}