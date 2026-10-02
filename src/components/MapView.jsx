// Leaflet wrapper. OpenStreetMap tiles, no API key, no marker image assets: bins
// are circles coloured by fill level, trucks are small boxes, roads come from
// the same graph the router uses.

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { LEVEL_STYLE, MAP_CENTER, MAP_ZOOM, levelOf } from '../lib/format.js'

const TILES = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIB = '&copy; OpenStreetMap contributors'

function nearestEdge(edges, latlng) {
  let best = null
  let bestDist = Infinity
  for (const e of edges) {
    const a = e.from
    const b = e.to
    const d = distanceToSegment(latlng.lat, latlng.lng, a.lat, a.lng, b.lat, b.lng)
    if (d < bestDist) {
      bestDist = d
      best = e
    }
  }
  return bestDist < 0.0015 ? best : null
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function binIcon(color, selected) {
  return L.divIcon({
    className: '',
    html: `<span class="cr-marker${selected ? '' : ' cr-marker--sm'}" style="background:${color}"></span>`,
    iconSize: selected ? [18, 18] : [12, 12],
    iconAnchor: selected ? [9, 9] : [6, 6],
  })
}

function placeIcon(kind, label) {
  const cls = kind === 'depot' ? 'cr-depot' : 'cr-truck'
  const color = kind === 'depot' ? '#ffffff' : label === 'down' ? '#b91c1c' : '#0f5132'
  return L.divIcon({
    className: '',
    html: `<span class="${cls}" style="color:${color}">${kind === 'depot' ? 'D' : 'T'}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  })
}

function stopIcon(order, done) {
  return L.divIcon({
    className: '',
    html: `<span class="cr-truck" style="color:${done ? '#15803d' : '#0f5132'};font-size:11px">${order}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

export default function MapView({
  center = MAP_CENTER,
  zoom = MAP_ZOOM,
  points = [],
  stops = [],
  trucks = [],
  places = [],
  blockedRoads = [],
  graph = { nodes: [], edges: [] },
  selectedPointId = null,
  pin = null,
  roadMode = false,
  onPointClick,
  onMapClick,
  onRoadClick,
  colourFor = (p) => LEVEL_STYLE[levelOf(p.estimated_level)]?.bar || '#737373',
  className = '',
  fit = true,
}) {
  const holder = useRef(null)
  const map = useRef(null)
  const layer = useRef(null)
  const handlers = useRef({})
  handlers.current = { onPointClick, onMapClick, onRoadClick, roadMode }

  useEffect(() => {
    if (!holder.current || map.current) return
    const m = L.map(holder.current, {
      center,
      zoom,
      zoomControl: true,
      attributionControl: true,
    })
    L.tileLayer(TILES, { attribution: ATTRIB, maxZoom: 19 }).addTo(m)
    layer.current = L.layerGroup().addTo(m)
    m.on('click', (e) => {
      const h = handlers.current
      if (h.roadMode) h.onRoadClick?.(e.latlng)
      else h.onMapClick?.(e.latlng)
    })
    map.current = m
    setTimeout(() => {
      m.invalidateSize()
    }, 0)
    return () => {
      m.remove()
      map.current = null
      layer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const m = map.current
    const g = layer.current
    if (!m || !g) return
    g.clearLayers()

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
    const blockedKeys = new Set(blockedRoads.map((b) => `${b.a}|${b.b}`))

    for (const e of graph.edges) {
      const a = nodeById.get(e.a)
      const b = nodeById.get(e.b)
      if (!a || !b) continue
      const isBlocked = blockedKeys.has(`${e.a}|${e.b}`) || blockedKeys.has(`${e.b}|${e.a}`)
      L.polyline(
        [
          [a.lat, a.lng],
          [b.lat, b.lng],
        ],
        { color: isBlocked ? '#b91c1c' : '#9a9a9a', weight: isBlocked ? 4 : 2, opacity: 0.55, dashArray: isBlocked ? '5 4' : null },
      ).addTo(g)
    }

    for (const p of places) {
      L.marker([p.lat, p.lng], { icon: placeIcon(p.kind), keyboard: false })
        .bindPopup(`<strong>${escapeHtml(p.name)}</strong><br/>${escapeHtml(p.kind)}`)
        .addTo(g)
    }

    for (const t of trucks) {
      if (t.lat == null || t.lng == null) continue
      L.marker([t.lat, t.lng], { icon: placeIcon('truck', t.status), keyboard: false })
        .bindPopup(`<strong>${escapeHtml(t.name || t.id)}</strong><br/>${escapeHtml(t.status || '')}`)
        .addTo(g)
    }

    for (const s of stops) {
      const p = points.find((x) => x.id === s.point_id)
      if (!p) continue
      const done = s.status === 'done'
      L.marker([p.lat, p.lng], { icon: stopIcon(s.stop_order, done), keyboard: false })
        .bindPopup(`<strong>Stop ${s.stop_order}</strong><br/>${escapeHtml(p.code)} ${escapeHtml(p.name)}`)
        .addTo(g)
    }

    for (const p of points) {
      const m2 = L.marker([p.lat, p.lng], {
        icon: binIcon(colourFor(p), p.id === selectedPointId),
        keyboard: false,
        zIndexOffset: p.id === selectedPointId ? 500 : 0,
      })
      m2.bindPopup(
        `<strong>${escapeHtml(p.code)}</strong><br/>${escapeHtml(p.name)}<br/>${Math.round(p.estimated_level)}%`,
      )
      m2.on('click', () => handlers.current.onPointClick?.(p))
      m2.addTo(g)
    }

    if (pin) {
      L.marker([pin.lat, pin.lng], { icon: binIcon('#0f5132', true), keyboard: false, zIndexOffset: 800 })
        .addTo(g)
      L.circle([pin.lat, pin.lng], { radius: 40, color: '#0f5132', weight: 2, fillOpacity: 0.08 }).addTo(g)
    }

    if (fit && points.length) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]))
      m.fitBounds(bounds.pad(0.15), { animate: false })
    }
  }, [points, stops, trucks, places, blockedRoads, graph, selectedPointId, pin, fit, colourFor])

  return (
    <div
      ref={holder}
      className={`h-[300px] w-full border border-line bg-[#e8e8e8] ${className}`}
      aria-label="map"
    />
  )
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}