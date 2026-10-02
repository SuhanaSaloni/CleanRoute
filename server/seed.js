// Deterministic seed for a Hyderabad-shaped city. Same numbers on every reset,
// so the demo script and the screenshots always line up.

import { makeRng, between } from '../src/algorithms/rng.js'

export const DEPOT = {
  id: 'depot-1',
  name: 'Bandlaguda Municipal Depot',
  kind: 'depot',
  lat: 17.3866,
  lng: 78.4788,
}

export const YARDS = [
  { id: 'yard-1', name: 'Nagarjuna Hills Transfer Yard', kind: 'dump_yard', lat: 17.4272, lng: 78.4769 },
  { id: 'yard-2', name: 'Kukatpally Transfer Yard', kind: 'dump_yard', lat: 17.4431, lng: 78.3622 },
]

export const WARDS = [
  { id: 'W11', name: 'Charminar Market', lat: 17.3616, lng: 78.4747 },
  { id: 'W12', name: 'KPHB Residential', lat: 17.4408, lng: 78.3479 },
  { id: 'W09', name: 'HITEC City Commercial', lat: 17.4435, lng: 78.3772 },
  { id: 'W01', name: 'King Koti Civic', lat: 17.4197, lng: 78.4786 },
  { id: 'W19', name: 'Yousufguda Institutional', lat: 17.4165, lng: 78.4183 },
]

/**
 * Road graph: a 5 x 8 lattice plus diagonals, about 40 nodes.
 * Node id "n<row><col>" so blocked roads can be named in the UI.
 */
export function seedRoadGraph() {
  const nodes = []
  const edges = []
  const lat0 = 17.335
  const lng0 = 78.325
  const dLat = 0.0165
  const dLng = 0.0192
  const rows = 5
  const cols = 8
  const id = (r, c) => `n${r}${c}`
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      nodes.push({
        id: id(r, c),
        lat: +(lat0 + r * dLat).toFixed(5),
        lng: +(lng0 + c * dLng).toFixed(5),
        label: `Junction ${r + 1}${c + 1}`,
      })
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) edges.push({ a: id(r, c), b: id(r, c + 1), name: `Row ${r + 1} main road` })
      if (r + 1 < rows) edges.push({ a: id(r, c), b: id(r + 1, c), name: `Column ${c + 1} main road` })
      if (c + 1 < cols && r + 1 < rows && (r + c) % 3 === 0) {
        edges.push({ a: id(r, c), b: id(r + 1, c + 1), name: `Cross link ${r + 1}${c + 1}` })
      }
    }
  }
  return { nodes, edges }
}

const NAMES = {
  public_bin: [
    'Corner bin', 'Bus stop bin', 'Temple bin', 'Tea stall bin', 'Lane bin',
    'Water point bin', 'Gate bin', 'Bazaar bin', 'School gate bin', 'Canal side bin',
  ],
  informal_dump: [
    'Open dump beside the drain', 'Encroachment dump', 'Riverbed dump',
    'Under-bridge dump', 'Brick kiln approach dump',
  ],
  bulk_generator: [
    'Apartment waste room', 'Hospital waste yard', 'School canteen store',
    'Office tower basement', 'Hotel kitchen store', 'Clinic store',
    'Temple kitchen', 'Hostel kitchen',
  ],
}

const LANDMARKS = [
  'near the ration shop', 'beside the water tank', 'opposite the police outpost',
  'behind the temple', 'next to the clinic', 'under the flyover',
  'at the main gate', 'near the vegetable market', 'by the tea stall', 'corner of the lane',
  'inside the compound', 'near the gate pillar',
]

const AREA_TYPE = {
  public_bin: ['residential', 'market', 'street', 'commercial', 'residential', 'market'],
  informal_dump: ['street', 'market', 'residential', 'commercial'],
  bulk_generator: ['residential', 'commercial', 'hospital', 'school', 'commercial'],
}

const LOAD = { public_bin: 110, informal_dump: 420, bulk_generator: 320 }

/**
 * 40 points across 5 wards.
 * 1 hospital, 1 school, 3 apartments, 4 informal dumps, the rest public bins.
 */
export function seedPoints() {
  const rng = makeRng(20260917)
  const out = []
  const plan = [
    { ward: 'W11', area: 'market', type: 'public_bin', count: 8 },
    { ward: 'W12', area: 'residential', type: 'public_bin', count: 8 },
    { ward: 'W09', area: 'commercial', type: 'public_bin', count: 8 },
    { ward: 'W01', area: 'street', type: 'public_bin', count: 5 },
    { ward: 'W19', area: 'residential', type: 'public_bin', count: 2 },
    { ward: 'W11', area: 'market', type: 'informal_dump', count: 2 },
    { ward: 'W12', area: 'residential', type: 'informal_dump', count: 1 },
    { ward: 'W01', area: 'street', type: 'informal_dump', count: 1 },
    { ward: 'W12', area: 'residential', type: 'bulk_generator', count: 3, label: 'apartment' },
    { ward: 'W19', area: 'hospital', type: 'bulk_generator', count: 1, label: 'hospital' },
    { ward: 'W19', area: 'school', type: 'bulk_generator', count: 1, label: 'school' },
  ]

  const counters = {}
  for (const p of plan) {
    for (let k = 0; k < p.count; k++) {
      counters[p.ward] = (counters[p.ward] || 0) + 1
      const ward = WARDS.find((w) => w.id === p.ward)
      const lat = +(ward.lat + between(rng, -0.0125, 0.0125)).toFixed(5)
      const lng = +(ward.lng + between(rng, -0.0145, 0.0145)).toFixed(5)
      const seq = counters[p.ward]
      let name
      if (p.label === 'hospital') name = 'Government General Hospital waste yard'
      else if (p.label === 'school') name = 'Zilla Parishad High School store'
      else if (p.label === 'apartment') name = ['Sri Venkata Residency', 'Lakshmi Enclave', 'Green Meadows Apartments'][k % 3]
      else if (p.type === 'informal_dump') name = NAMES.informal_dump[(k + seq) % NAMES.informal_dump.length]
      else name = `${NAMES.public_bin[(k + seq) % NAMES.public_bin.length]}`

      const base =
        p.type === 'informal_dump' ? between(rng, 5.5, 9)
        : p.type === 'bulk_generator' ? between(rng, 4.5, 7.5)
        : between(rng, 3.2, 6.4)

      out.push({
        id: `${p.ward}-${String(seq).padStart(2, '0')}`,
        code: `${p.ward}-B${String(seq).padStart(2, '0')}`,
        name,
        landmark: LANDMARKS[(k + seq) % LANDMARKS.length],
        lat,
        lng,
        ward: p.ward,
        ward_name: ward.name,
        area_type: p.area,
        type: p.type,
        base_fill_rate: +base.toFixed(2),
        expected_load_kg: LOAD[p.type],
        status: 'active',
      })
    }
  }
  return out
}

export function seedTrucks() {
  return [
    { id: 'truck-1', name: 'Compactor 1', plate: 'TS 07 AR 1001', capacity_kg: 3000, status: 'active', driver_id: 'drv-1' },
    { id: 'truck-2', name: 'Compactor 2', plate: 'TS 07 AR 1002', capacity_kg: 3000, status: 'active', driver_id: 'drv-2' },
    { id: 'truck-3', name: 'Compactor 3', plate: 'TS 07 AR 1003', capacity_kg: 2500, status: 'active', driver_id: 'drv-3' },
    { id: 'truck-4', name: 'Open Body 4', plate: 'TS 07 AR 1004', capacity_kg: 1800, status: 'active', driver_id: 'drv-4' },
  ]
}

export function seedDrivers() {
  return [
    { id: 'drv-1', name: 'Ramesh Yadav', phone: '9848012345', pin: '1234', truck_id: 'truck-1' },
    { id: 'drv-2', name: 'Sunita Bai', phone: '9848012346', pin: '2345', truck_id: 'truck-2' },
    { id: 'drv-3', name: 'Imran Khan', phone: '9848012347', pin: '3456', truck_id: 'truck-3' },
    { id: 'drv-4', name: 'Anjaiah Rao', phone: '9848012348', pin: '4567', truck_id: 'truck-4' },
  ]
}

export function seedOperators() {
  return [
    { email: 'operator@cleanroute.in', password: 'cleanroute', name: 'Control Room Operator' },
    { email: 'supervisor@cleanroute.in', password: 'ward123', name: 'Ward Supervisor' },
  ]
}

export function seedEvents(now) {
  const d = (days) => new Date(now + days * 864e5).toISOString()
  return [
    {
      id: 'ev-1',
      name: 'Sankranti Street Festival',
      ward: 'W11',
      start: d(1),
      end: d(3),
      multiplier: 1.6,
      status: 'active',
    },
    {
      id: 'ev-2',
      name: 'HITEC Campus Tech Expo',
      ward: 'W09',
      start: d(5),
      end: d(6),
      multiplier: 1.4,
      status: 'active',
    },
    {
      id: 'ev-3',
      name: 'Citywide Weekend Camp',
      ward: 'all',
      start: d(-2),
      end: d(9),
      multiplier: 1.15,
      status: 'active',
    },
  ]
}

export function seedSettings() {
  return {
    threshold: 70,
    forced_threshold: 90,
    cost_per_km: 12,
    shift_hours: 8,
    avg_speed_kph: 22,
    service_minutes: 6,
    fuel_price_per_litre: 105,
    co2_kg_per_litre: 2.32,
    ward_helpline: '1800-200-4477',
    report_rate_limit_minutes: 30,
    device_cap_points: 15,
    approval_hours: 24,
  }
}

/** Device pool for generated history, with a realistic trust spread. */
export function seedDevices(now) {
  const rng = makeRng(77001)
  const out = []
  for (let i = 0; i < 24; i++) {
    const trust = +(0.25 + rng() * 0.5).toFixed(2)
    out.push({
      device_id: `dev-${String(i + 1).padStart(2, '0')}`,
      trust,
      first_seen: new Date(now - between(rng, 5, 26) * 864e5).toISOString(),
      last_seen: new Date(now - between(rng, 0, 4) * 864e5).toISOString(),
    })
  }
  return out
}

export const HISTORY_DAYS = 30

/**
 * 30 days of generated history: reports from the device pool, emptied events,
 * and a matching prediction log. The most recent hours are left un-emptied so
 * the demo opens with a live backlog.
 */
export function seedHistory(points, devices, now) {
  const rng = makeRng(31337)
  const reports = []
  const emptied = {}
  const preds = []

  for (const p of points) {
    emptied[p.id] = []
  }

  for (let day = HISTORY_DAYS; day >= 0; day--) {
    for (const p of points) {
      const hoursPerDay = 100 / p.base_fill_rate
      const perDay = Math.max(1, Math.round(24 / hoursPerDay))
      for (let k = 0; k < perDay; k++) {
        const at = now - day * 864e5 + between(rng, 6, 20) * 36e5
        if (at > now) continue
        const d = devices[Math.floor(rng() * devices.length)]
        const roll = rng()
        const level = roll < 0.08 ? 'empty' : roll < 0.44 ? 'half' : roll < 0.9 ? 'full' : 'overflowing'
        const source = ['saved', 'search', 'typed', 'pin', 'gps'][Math.floor(rng() * 5)]
        reports.push({
          point_id: p.id,
          device_id: d.device_id,
          level,
          source,
          lat: +(p.lat + between(rng, -0.0008, 0.0008)).toFixed(5),
          lng: +(p.lng + between(rng, -0.0008, 0.0008)).toFixed(5),
          created_at: new Date(at).toISOString(),
        })
        if (level === 'full' || level === 'overflowing') {
          const hh = (at - (emptied[p.id].at(-1)?.at || at - hoursPerDay * 36e5)) / 36e5
          preds.push({
            point_id: p.id,
            at: new Date(at).toISOString(),
            predicted_hours: +(hoursPerDay * between(rng, 0.82, 1.18)).toFixed(2),
            actual_hours: +Math.max(0.5, hh).toFixed(2),
            outcome: level,
          })
        }
      }
    }
    // The depot empties most points once a day for the last 5 days only,
      // which leaves a realistic backlog rather than a fully clean city.
      if (day <= 5) {
        for (const p of points) {
          if (rng() > 0.72) {
            const at = now - day * 864e5 + between(rng, 6, 11) * 36e5
            // Never in the future: a future emptied time would freeze the estimate.
            if (at <= now) emptied[p.id].push({ at: new Date(at).toISOString() })
          }
        }
      }
  }

  return { reports, emptied, preds }
}

export const DEMO_WARDS = WARDS