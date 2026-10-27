// Local dashboard server: serves index.html and streams the session logs in
// events/*.jsonl over SSE.
// Usage: node server.js [port]   (default 7777)
//
// Every event gets an id "<epoch>-<seq>". A browser that reconnects sends the
// last id it saw (Last-Event-ID) and receives only the events after it. When
// the id is from another epoch (server restart, logs cleared or shrunk) or is
// missing, the server sends "reset" followed by the whole buffer, so the page
// rebuilds its state from scratch instead of adding to it.
//
// The hook only appends, one file per session. This server is the only one
// that deletes them (see prune).
const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = Number(process.argv[2]) || 7777
const EVENTS_DIR = path.join(__dirname, 'events')
const LEGACY = path.join(__dirname, 'events.jsonl')
const PAGE = path.join(__dirname, 'index.html')
const AGENTS_DIR = path.join(require('os').homedir(), '.claude', 'agents')
const KEEP = 5000

const KEEP_FILES = 30
const KEEP_DAYS = 7
const ACTIVE_MS = 30 * 60 * 1000 // a file written this recently is never deleted

// Only this machine's own names for the server: a page whose domain was
// rebound to 127.0.0.1 still sends its own Host and is refused.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`])
const ORIGINS = new Set([...HOSTS].map(h => `http://${h}`))

// A cross-site page cannot send a custom header without a CORS preflight,
// which this server never answers, so /clear only runs for the dashboard.
const isTrusted = req => {
  if (!HOSTS.has(req.headers.host)) return false
  const origin = req.headers.origin
  return origin === undefined || ORIGINS.has(origin)
}

const clients = new Set()
let epoch = Date.now().toString(36)
let buffer = [] // { seq, line }
let seq = 0
// file name -> { offset, partial }: partial holds bytes after the last newline
let files = new Map()

// A client that went away mid-write must not take the server down with it.
const send = (res, text) => {
  try {
    res.write(text)
  } catch {
    clients.delete(res)
  }
}
const write = (res, ev) => send(res, `id: ${epoch}-${ev.seq}\ndata: ${ev.line}\n\n`)
const reset = res => send(res, 'event: reset\ndata: {}\n\n')

const push = line => {
  const ev = { seq: ++seq, line }
  buffer.push(ev)
  if (buffer.length > KEEP) buffer.shift()
  return ev
}

const restart = () => {
  epoch = Date.now().toString(36)
  buffer = []
  seq = 0
  files = new Map()
}

const listLogs = () => {
  try {
    return fs.readdirSync(EVENTS_DIR).filter(f => f.endsWith('.jsonl'))
  } catch {
    return []
  }
}

// Reads the lines appended to one file since the last call. Lines are split
// on bytes so a multi-byte character cut at the read boundary is not garbled.
const readNew = (name, size, state) => {
  let chunk
  try {
    const fd = fs.openSync(path.join(EVENTS_DIR, name), 'r')
    try {
      chunk = Buffer.alloc(size - state.offset)
      fs.readSync(fd, chunk, 0, chunk.length, state.offset)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return []
  }
  state.offset = size

  const bytes = state.partial ? Buffer.concat([state.partial, chunk]) : chunk
  const end = bytes.lastIndexOf(0x0a)
  if (end === -1) {
    state.partial = bytes
    return []
  }
  state.partial = end + 1 < bytes.length ? bytes.subarray(end + 1) : null
  return bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)
}

const tsOf = line => {
  try {
    return JSON.parse(line).ts ?? 0
  } catch {
    return 0
  }
}

// Polls every session file for appended lines; robust on Windows where
// fs.watch is flaky. Lines read in one pass are ordered by time, so the first
// load interleaves the sessions correctly.
const poll = () => {
  const names = listLogs()
  const lines = []
  for (const name of names) {
    let size
    try {
      size = fs.statSync(path.join(EVENTS_DIR, name)).size
    } catch {
      continue
    }
    const state = files.get(name) ?? { offset: 0, partial: null }
    files.set(name, state)
    if (size < state.offset) {
      // A file shrank: someone rewrote it, so start over from all files
      restart()
      for (const res of clients) reset(res)
      return poll()
    }
    if (size > state.offset) lines.push(...readNew(name, size, state))
  }
  for (const name of files.keys()) if (!names.includes(name)) files.delete(name)
  return lines
    .map(line => ({ line, ts: tsOf(line) }))
    .sort((a, b) => a.ts - b.ts)
    .map(x => push(x.line))
}

const logFor = session =>
  path.join(EVENTS_DIR, `${String(session || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)

// One-time move of the single events.jsonl of earlier versions into session
// files; the original is kept as events.jsonl.migrated.
const migrate = () => {
  if (!fs.existsSync(LEGACY)) return
  try {
    const bySession = new Map()
    for (const line of fs.readFileSync(LEGACY, 'utf8').split('\n').filter(Boolean)) {
      let session
      try {
        session = JSON.parse(line).session
      } catch {
        continue
      }
      const file = logFor(session)
      bySession.set(file, (bySession.get(file) ?? '') + line + '\n')
    }
    fs.mkdirSync(EVENTS_DIR, { recursive: true })
    for (const [file, text] of bySession) fs.appendFileSync(file, text)
    fs.renameSync(LEGACY, `${LEGACY}.migrated`)
    console.log(`events.jsonl -> events/ (${bySession.size} sessions)`)
  } catch (err) {
    console.error('migration failed:', err.message)
  }
}

// Keeps the newest KEEP_FILES session files and none older than KEEP_DAYS,
// but never deletes a file written within ACTIVE_MS: that session may be live.
const prune = () => {
  const now = Date.now()
  const stats = listLogs()
    .map(name => {
      try {
        return { name, mtime: fs.statSync(path.join(EVENTS_DIR, name)).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
  stats.forEach(({ name, mtime }, i) => {
    const age = now - mtime
    if (age < ACTIVE_MS) return
    if (i < KEEP_FILES && age < KEEP_DAYS * 86400e3) return
    try {
      fs.unlinkSync(path.join(EVENTS_DIR, name))
      files.delete(name)
    } catch {}
  })
}

const broadcast = fresh => {
  for (const res of clients) for (const ev of fresh) write(res, ev)
}

migrate()
prune()
poll()

setInterval(() => {
  try {
    broadcast(poll())
  } catch (err) {
    console.error('poll failed:', err.message)
  }
}, 300)
setInterval(prune, 10 * 60 * 1000)

const handle = (req, res) => {
  if (!isTrusted(req)) {
    res.writeHead(403).end()
    return
  }
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    // Catch up first so the buffer and the live stream meet exactly.
    broadcast(poll())

    const [lastEpoch, lastSeq] = String(req.headers['last-event-id'] ?? '').split('-')
    const since = Number(lastSeq)
    const first = buffer[0]?.seq ?? seq + 1
    if (lastEpoch === epoch && since >= first - 1 && since <= seq) {
      for (const ev of buffer) if (ev.seq > since) write(res, ev)
    } else {
      reset(res)
      for (const ev of buffer) write(res, ev)
    }
    clients.add(res)
    req.on('close', () => clients.delete(res))
    res.on('error', () => clients.delete(res))
    return
  }
  if (req.url === '/clear' && req.method === 'POST') {
    if (req.headers['x-dashboard'] !== '1') {
      res.writeHead(403).end()
      return
    }
    for (const name of listLogs()) {
      try {
        fs.unlinkSync(path.join(EVENTS_DIR, name))
      } catch {}
    }
    restart()
    for (const c of clients) reset(c)
    res.writeHead(204).end()
    return
  }
  if (req.url === '/agents') {
    let names = []
    try {
      names = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)).sort()
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(names))
    return
  }
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(PAGE, (err, page) => {
      if (err) {
        res.writeHead(500).end('index.html을 읽지 못했습니다.')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      })
      res.end(page)
    })
    return
  }
  res.writeHead(404).end()
}

http
  .createServer((req, res) => {
    try {
      handle(req, res)
    } catch (err) {
      console.error('request failed:', err.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  })
  .on('error', err => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `포트 ${PORT}을 이미 사용 중입니다. 다른 포트로 실행하세요: node server.js <포트>`
        : `서버 오류: ${err.message}`,
    )
    process.exit(1)
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Agent dashboard: http://localhost:${PORT}`)
  })

setInterval(() => {
  for (const res of clients) send(res, ': ping\n\n')
}, 15000)
