// Single-port server: the API and the built SPA on the same origin and port,
// so the app can be published anywhere without a second service.

import http from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { handleApi } from './api.js'
import { isSeeded, seedAll, stats } from './store.js'
import { getDb } from './db.js'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')
const PORT = Number(process.env.PORT || 8081)
const HOST = process.env.HOST || '0.0.0.0'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

getDb()
if (!isSeeded()) {
  const t0 = Date.now()
  seedAll()
  console.log(`[cleanroute] seeded database in ${Date.now() - t0}ms`, stats())
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type',
    })
    return res.end()
  }

  if (url.pathname.startsWith('/api')) {
    res.setHeader('access-control-allow-origin', '*')
    const out = await handleApi(req, res, url)
    if (out && out.status === 0) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `no route for ${req.method} ${url.pathname}` }))
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    return res.end()
  }

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  let file = rel && !rel.includes('..') ? join(DIST, rel) : null
  if (file && !existsSync(file)) file = null
  if (!file) file = join(DIST, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(
      '<!doctype html><meta charset="utf-8"><title>CleanRoute</title><p style="font:16px system-ui;padding:24px">The web app has not been built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> for the Vite dev server.</p>',
    )
  }
  const ext = extname(file)
  const immutable = /\/assets\//.test(file)
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
})

server.listen(PORT, HOST, () => {
  const s = stats()
  console.log(`[cleanroute] listening on http://${HOST}:${PORT}`)
  console.log(`[cleanroute] ${s.points} points, ${s.reports} reports, ${s.devices} devices, ${s.stops} stops`)
  if (!statSync(DIST).isDirectory) console.log('[cleanroute] dist/ not present')
})