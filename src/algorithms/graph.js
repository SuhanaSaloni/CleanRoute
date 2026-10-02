// Road graph: nodes, edges, snapping, Dijkstra with an indexed binary min-heap.
// Pure functions only. No I/O, no globals.

export const HEAP = { ok: 'ok' }

/** Indexed binary min-heap keyed by `key` property. O(1) push, O(log n) pop. */
export class MinHeap {
  constructor(key = 'key') {
    this.items = []
    this.pos = new Map()
    this.key = key
  }

  get size() {
    return this.items.length
  }

  push(item) {
    const k = item[this.key]
    if (this.pos.has(item)) return
    this.pos.set(item, this.items.length)
    this.items.push(item)
    this._up(this.items.length - 1)
  }

  pop() {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop()
    this.pos.delete(top)
    if (this.items.length > 0) {
      this.items[0] = last
      this.pos.set(last, 0)
      this._down(0)
    }
    return top
  }

  _less(a, b) {
    return a[this.key] < b[this.key]
  }

  _up(i) {
    const it = this.items
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this._less(it[i], it[p])) break
      ;[it[i], it[p]] = [it[p], it[i]]
      this.pos.set(it[i], i)
      this.pos.set(it[p], p)
      i = p
    }
  }

  _down(i) {
    const it = this.items
    const n = it.length
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let s = i
      if (l < n && this._less(it[l], it[s])) s = l
      if (r < n && this._less(it[r], it[s])) s = r
      if (s === i) break
      ;[it[i], it[s]] = [it[s], it[i]]
      this.pos.set(it[i], i)
      this.pos.set(it[s], s)
      i = s
    }
  }
}

export function haversineKm(a, b) {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Build a road graph from plain nodes + edges.
 * nodes: [{ id, lat, lng }]   edges: [{ a, b, km?, blocked? }]
 * Undirected. Node id must be a string.
 */
export function buildGraph(nodes, edges) {
  const adj = new Map()
  const index = new Map()
  nodes.forEach((n, i) => {
    adj.set(n.id, [])
    index.set(n.id, i)
  })
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b) || e.a === e.b) continue
    const na = nodes[index.get(e.a)]
    const nb = nodes[index.get(e.b)]
    const km = e.km != null ? e.km : haversineKm(na, nb) * 1.18 // road detour factor
    if (!isFinite(km) || km <= 0) continue
    adj.get(e.a).push({ to: e.b, km, blocked: !!e.blocked })
    adj.get(e.b).push({ to: e.a, km, blocked: !!e.blocked })
  }
  return { nodes, adj, index }
}

/** Snap a lat/lng to the closest graph node. Brute force is fine for ~40 nodes: O(n). */
export function snapNode(graph, lat, lng) {
  let best = null
  let bestD = Infinity
  for (const n of graph.nodes) {
    const d = (n.lat - lat) ** 2 + (n.lng - lng) ** 2
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return { id: best.id, offsetKm: Math.sqrt(bestD) * 111, node: best }
}

/**
 * Dijkstra with a binary min-heap.
 * Returns { dist: Map<id, km>, prev: Map<id, id> }. Blocked edges are skipped.
 * Complexity: O((V + E) log V)
 */
export function dijkstra(graph, sourceId) {
  const dist = new Map()
  const prev = new Map()
  const done = new Set()
  if (!graph.adj.has(sourceId)) return { dist, prev }
  dist.set(sourceId, 0)
  const heap = new MinHeap('d')
  heap.push({ id: sourceId, d: 0 })
  while (heap.size) {
    const cur = heap.pop()
    if (done.has(cur.id)) continue
    done.add(cur.id)
    const d = dist.get(cur.id)
    for (const e of graph.adj.get(cur.id) || []) {
      if (e.blocked) continue
      const nd = d + e.km
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        prev.set(e.to, cur.id)
        heap.push({ id: e.to, d: nd })
      }
    }
  }
  return { dist, prev }
}

/** Single pair shortest distance in km. Infinity if unreachable. */
export function shortestKm(graph, fromId, toId) {
  if (fromId === toId) return 0
  const { dist } = dijkstra(graph, fromId)
  const v = dist.get(toId)
  return v == null ? Infinity : v
}

/** Reconstruct the node id path. Returns [] when unreachable. */
export function pathBetween(prev, fromId, toId) {
  const out = []
  let cur = toId
  while (cur != null) {
    out.push(cur)
    if (cur === fromId) return out.reverse()
    cur = prev.get(cur)
  }
  return []
}

/** All pairs shortest distances. O(V) Dijkstra runs = O(V * (V+E) log V). */
export function allPairs(graph) {
  const m = new Map()
  for (const n of graph.nodes) m.set(n.id, dijkstra(graph, n.id).dist)
  return m
}

/**
 * Solve the whole problem as a dense metric over places (depot, points, yards).
 * Places get snapped once; distances come from one Dijkstra per place, so the
 * cost matrix is a true road distance matrix, not straight lines.
 * Complexity: O(P * (V + E) log V) time, O(P * V) memory.
 */
export function buildMetric(graph, places) {
  const snapped = places.map((p, i) => ({ place: p, ...snapNode(graph, p.lat, p.lng), i }))
  const matrix = []
  for (const s of snapped) {
    const { dist } = dijkstra(graph, s.id)
    const row = snapped.map((t) => {
      const base = dist.get(t.id)
      if (base == null) return Infinity
      return Math.max(0, base + (s.offsetKm || 0) + (t.offsetKm || 0))
    })
    matrix.push(row)
  }
  return {
    matrix,
    node: snapped.map((s) => s.id),
    place: snapped.map((s) => s.place),
    offsetKm: snapped.map((s) => s.offsetKm || 0),
    /** at(a, b) takes plain 0-based indices into the `places` array. */
    at: (a, b) => matrix[a][b],
  }
}