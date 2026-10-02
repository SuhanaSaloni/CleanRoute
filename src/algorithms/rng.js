// Deterministic pseudo random numbers. Seeded so demo data is identical on every reset.
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1
  return function rng() {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length) % arr.length]
}

export function between(rng, lo, hi) {
  return lo + rng() * (hi - lo)
}

export function intBetween(rng, lo, hi) {
  return Math.floor(between(rng, lo, hi + 1 - 1e-9))
}