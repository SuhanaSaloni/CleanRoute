// Wipes and re-seeds the database. `npm run reset`
import { seedAll, stats } from './store.js'
import { getDb } from './db.js'

getDb()
const t0 = Date.now()
seedAll()
console.log(`[cleanroute] reset in ${Date.now() - t0}ms`, stats())