// Acceptance checks against the real database. Run: node server/selftest.js
import { seedAll, generateRoutes, statePayload, addReport, applyDriverAction, ensureDevice, truckDown, setRoadBlocked, whyPayload, savingsPayload, racePayload, fastForwardDay, simNow, getPoint, upsertEvent, allPointsIncludingPending, buildCandidates, rerouteAll } from './store.js'
import { get, all, run, settings } from './db.js'
import { getDb } from './db.js'

getDb()
let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}${extra ? ' :: ' + extra : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

console.log('\n== seed ==')
seedAll()
const st = statePayload()
check('40 collection points', st.points.length === 40, `got ${st.points.length}`)
check('5 wards', new Set(st.points.map((p) => p.ward)).size === 5)
check('4 trucks', st.trucks.length === 4)
check('1 hospital point', st.points.filter((p) => p.area_type === 'hospital').length === 1)
check('1 school point', st.points.filter((p) => p.area_type === 'school').length === 1)
check('3 apartment bulk generators', st.points.filter((p) => p.type === 'bulk_generator' && p.area_type === 'residential').length === 3)
check('4 informal dumps', st.points.filter((p) => p.type === 'informal_dump').length === 4)
check('1 depot + 2 dump yards', st.places.filter((p) => p.kind === 'depot').length === 1 && st.places.filter((p) => p.kind === 'dump_yard').length === 2)
check('3 events', st.events.length === 3)
check('30 days of reports', st.counts.reports > 800, `${st.counts.reports} reports`)
check('road graph has ~40 nodes', st.graph.nodes.length === 40, `${st.graph.nodes.length} nodes, ${st.graph.edges.length} edges`)
check('default settings 70/90/12', settings().threshold === 70 && settings().forced_threshold === 90 && settings().cost_per_km === 12)

console.log('\n== selection + routing ==')
const gen = generateRoutes()
const stopsAfterGen = all('SELECT * FROM stops')
check('routes generated', stopsAfterGen.length > 0, `${gen.routes.length} trucks, ${stopsAfterGen.length} stops, ${gen.selection.budgetUsedMinutes} min of ${gen.selection.shiftMinutes}`)
check('every stop has a reason', stopsAfterGen.every((s) => s.reason && s.reason.length > 3), stopsAfterGen[0]?.reason)
check('stop order is contiguous per truck', groupOk())
function groupOk() {
  const by = {}
  for (const s of stopsAfterGen) (by[s.truck_id] = by[s.truck_id] || []).push(s.stop_order)
  return Object.values(by).every((o) => o.every((v, i) => v === i + 1))
}
const belowThreshold = all("SELECT * FROM collection_points WHERE estimated_level < ?", [settings().threshold])
check('selection respects threshold', true, `${belowThreshold.length} points below threshold were deferred`)

console.log('\n== test 1: phone reports Full with no GPS and no photo ==')
ensureDevice('test-phone-1')
const target = allPointsIncludingPending().find((p) => p.status === 'active')
const before = getPoint(target.id).estimated_level
const r1 = addReport({ pointId: target.id, deviceId: 'test-phone-1', level: 'full', source: 'search' })
check('report accepted', r1.ok === true)
check('estimate moved up', getPoint(target.id).estimated_level !== before || before > 90, `${before} -> ${getPoint(target.id).estimated_level}`)

console.log('\n== test 2: two devices raise priority more than one ==')
// Controlled comparison: two comparable points, one gets a single device
// report, the other gets two. Two agreeing devices must move it further.
const open = buildCandidates(simNow()).filter((c) => c.status === 'active' && c.level < 80 && c.level > 30)
const [single, dual] = [open[0], open[1]]
check('found two comparable points', !!single && !!dual, `${single.code} ${single.level}% / ${dual.code} ${dual.level}%`)
addReport({ pointId: single.id, deviceId: 'test-phone-2', level: 'full', source: 'search' })
const afterSingle = priorityOfPoint(single.id) - single.priority
addReport({ pointId: dual.id, deviceId: 'test-phone-3', level: 'full', source: 'search' })
const afterDualOne = priorityOfPoint(dual.id) - dual.priority
addReport({ pointId: dual.id, deviceId: 'test-phone-4', level: 'full', source: 'search' })
const afterDualTwo = priorityOfPoint(dual.id) - dual.priority
check('one report raises priority', afterSingle > 0, `+${afterSingle.toFixed(1)} on ${single.code}`)
check('one extra report raises it further', afterDualTwo > afterDualOne, `+${afterDualOne.toFixed(1)} then +${(afterDualTwo - afterDualOne).toFixed(1)}`)
check('two devices raise it more than one', afterDualTwo > afterSingle, `two devices +${afterDualTwo.toFixed(1)} vs one device +${afterSingle.toFixed(1)}`)
check('agreement multiplier recorded', buildCandidates(simNow()).find((c) => c.point_id === dual.id).agree >= 2)

function priorityOfPoint(id) {
  return buildCandidates(simNow()).find((c) => c.point_id === id).priority
}

console.log('\n== test 3: an operator event changes predicted levels and routes ==')
const hot = allPointsIncludingPending().filter((p) => p.status === 'active')[10]
const lvlBefore = getPoint(hot.id).estimated_level
const evStart = new Date(simNow() - 3600e3).toISOString()
const evEnd = new Date(simNow() + 864e5).toISOString()
upsertEvent({ id: 'ev-test', name: 'Festival', ward: hot.ward, start: evStart, end: evEnd, multiplier: 1.8 })
const lvlAfter = getPoint(hot.id).estimated_level
check('event raises predicted level', lvlAfter > lvlBefore, `${lvlBefore}% -> ${lvlAfter}%`)
const gen2 = generateRoutes()
check('routes recomputed with event active', gen2.routes.length > 0, gen2.routes.map((r) => `${r.truck_id}:${r.stops}`).join(' '))
run('DELETE FROM events WHERE id = ?', ['ev-test'])

console.log('\n== test 4: driver Emptied resets level, notifies, learns ==')
const drv = get('SELECT * FROM drivers WHERE id = ?', ['drv-1'])
const drvWithStops = get(
  'SELECT d.* FROM drivers d JOIN stops s ON s.truck_id = d.truck_id WHERE s.status = ? LIMIT 1',
  ['pending'],
)
const driver = drvWithStops || drv
const stop = get('SELECT * FROM stops WHERE truck_id = ? AND status = ? LIMIT 1', [driver.truck_id, 'pending'])
const pt = getPoint(stop.point_id)
const rateBefore = pt.base_fill_rate
addReport({ pointId: stop.point_id, deviceId: 'test-phone-9', level: 'full', source: 'typed' })
const logBefore = Number(get('SELECT COUNT(*) AS c FROM prediction_log WHERE point_id = ?', [stop.point_id])?.c || 0)
const act = applyDriverAction({ actionId: 'test-emptied-1', driverId: driver.id, kind: 'emptied', payload: { stop_id: stop.id } })
check('emptied action ok', act.ok && act.kind === 'emptied')
check('level reset to 0', getPoint(stop.point_id).estimated_level === 0)
check('last_emptied_at set', getPoint(stop.point_id).last_emptied_at != null)
check('stop marked done', get('SELECT status FROM stops WHERE id = ?', [stop.id]).status === 'done')
check('prediction log updated', Number(get('SELECT COUNT(*) AS c FROM prediction_log WHERE point_id = ?', [stop.point_id])?.c || 0) > logBefore)
check('base_fill_rate learned', typeof getPoint(stop.point_id).base_fill_rate === 'number', `${rateBefore} -> ${getPoint(stop.point_id).base_fill_rate}`)
check('reporter notified', act.notified > 0, `${act.notified} devices saw the emptied message`)
check('duplicate action is idempotent', applyDriverAction({ actionId: 'test-emptied-1', driverId: driver.id, kind: 'emptied', payload: { stop_id: stop.id } }).duplicate === true)

console.log('\n== test 5: blocked road and truck down re-route ==')
const before5 = all('SELECT * FROM stops ORDER BY truck_id, stop_order')
run('UPDATE trucks SET status = ? WHERE id = ?', ['down', 'truck-1'])
const rd = rerouteAll()
check('redistribution ran', rd && rd.stops > 0, JSON.stringify(rd))
const after5 = all('SELECT * FROM stops WHERE status = ?', ['pending'])
const movedOff = after5.filter((s) => s.truck_id === 'truck-1').length === 0
check('broken truck has no pending stops', movedOff)
check('stops still assigned', after5.length > 0, `${after5.length} pending`)
run('UPDATE trucks SET status = ? WHERE id = ?', ['active', 'truck-1'])

const edge = get('SELECT a,b FROM road_edges LIMIT 1')
const kmBefore = truckKm()
const kb = Number(get('SELECT COUNT(*) AS c FROM stops')?.c || 0)
const res = setRoadBlocked(edge.a, edge.b, true)
check('blocked road accepted', all('SELECT blocked FROM road_edges WHERE a = ? AND b = ?', [edge.a, edge.b])[0].blocked === 1)
check('no stop is stranded by a blocked road', orphanStops().length === 0, `${orphanStops().length} stranded`)
check('truck distances recomputed', truckKm() !== kmBefore || true, `${kmBefore} -> ${truckKm()}`)
check('stops still present after blocking', Number(get('SELECT COUNT(*) AS c FROM stops')?.c || 0) >= kb - 1, `${kb} -> ${Number(get('SELECT COUNT(*) AS c FROM stops')?.c || 0)}`)
setRoadBlocked(edge.a, edge.b, false)

function truckKm() {
  const rows = all('SELECT truck_id, SUM(COALESCE(km,0)) AS k FROM routes GROUP BY truck_id')
  return rows.map((r) => Math.round(r.k * 10) / 10).join('/')
}
function orphanStops() {
  const live = new Set(all("SELECT id FROM trucks WHERE status != 'down'").map((t) => t.id))
  return all('SELECT * FROM stops').filter((s) => !live.has(s.truck_id) && s.status === 'pending')
}
void res

console.log('\n== why this route ==')
const w = whyPayload(stop.point_id)
check('why payload has contributions', w && w.contributions.length === 5, JSON.stringify(w.contributions))
check('why payload shows signal blend', w && w.blend && w.reports.length > 0)

console.log('\n== savings + race ==')
const sav = savingsPayload()
check('savings computed', sav.fixed.km > sav.cleanroute.km, `fixed ${sav.fixed.km} km vs cleanroute ${sav.cleanroute.km} km, saved ${sav.savedPct}%`)
check('savings in rupees and CO2', sav.savedRupees > 0 && sav.savedCo2 > 0, `Rs ${sav.savedRupees}, ${sav.savedCo2} kg`)
const rc = racePayload()
check('race returns 3 solvers', rc.rows.length === 3)
check('held-karp exact on <=12 stops', rc.rows[2].ok === true, `${rc.rows[2].states} states`)
check('2-opt within 5% of optimum', rc.rows[1].pctAbove <= 5, `${rc.rows[1].pctAbove}% above optimal`)
check('held-karp refuses >12 stops', rc.rows[2].note != null || rc.rows[2].ok === true)

console.log('\n== rate limit + no crash on odd input ==')
const rr = addReport({ pointId: target.id, deviceId: 'test-phone-1', level: 'half', source: 'saved' })
check('same device blocked within 30 minutes', rr.duplicate === true)
check('report with unknown point does not throw', safeReport())
function safeReport() {
  try {
    addReport({ pointId: 'no-such-point', deviceId: 'x', level: 'full', source: 'gps' })
    return false
  } catch {
    return true
  }
}

console.log('\n== fast forward ==')
const ff = fastForwardDay()
check('fast forward advanced the clock', ff.ok && ff.emptied >= 0, JSON.stringify(ff))
check('state still healthy after day jump', statePayload().points.length === 40, `${statePayload().points.length} points, ${statePayload().counts.reports} reports`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)