const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const os = require('os')

// Runs a copy of ../hook.js in a temp folder, so the real events/ is never touched
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-hook-'))
fs.copyFileSync(path.join(__dirname, '..', 'hook.js'), path.join(SANDBOX, 'hook.js'))
process.on('exit', () => fs.rmSync(SANDBOX, { recursive: true, force: true }))

const HOOK = path.join(SANDBOX, 'hook.js')
const EVDIR = path.join(SANDBOX, 'events')
const LOG = path.join(EVDIR, 'S1.jsonl')
const MB = 1024 * 1024
const AGENTS = ['architect','collector','debugger','docs-writer','implementer','reviewer','tester']

const reset = () => { fs.rmSync(EVDIR, { recursive: true, force: true }) }
const run = input => spawnSync('node', [HOOK], { input, encoding: 'utf8' })
const send = o => run(JSON.stringify(o))
const lines = (f = LOG) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [])

test('1. 7 agents x 4 events recorded with correct fields', () => {
  for (const a of AGENTS) {
    reset()
    const id = 'id-' + a
    send({ session_id: 'S1', hook_event_name: 'SubagentStart', agent_id: id, agent_type: a })
    send({ session_id: 'S1', hook_event_name: 'PreToolUse', agent_id: id, agent_type: a, tool_name: 'Read', tool_input: { file_path: '/x/y' } })
    send({ session_id: 'S1', hook_event_name: 'PostToolUse', agent_id: id, agent_type: a, tool_name: 'Bash', tool_input: { command: 'ls' } })
    send({ session_id: 'S1', hook_event_name: 'SubagentStop', agent_id: id, agent_type: a })
    const r = lines()
    assert.deepStrictEqual(r.map(x => x.event), ['SubagentStart','PreToolUse','PostToolUse','SubagentStop'], a)
    for (const x of r) {
      assert.strictEqual(x.agent_id, id); assert.strictEqual(x.agent_type, a)
      assert.strictEqual(typeof x.ts, 'number')
    }
    assert.strictEqual(r[1].tool, 'Read'); assert.strictEqual(r[1].input, '/x/y')
    assert.strictEqual(r[2].tool, 'Bash'); assert.strictEqual(r[2].input, 'ls')
  }
})

test('2. main thread tool calls (no agent_id) recorded as agent "main"', () => {
  reset()
  send({ session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: 'a' } })
  send({ session_id: 'S1', hook_event_name: 'PostToolUse', agent_id: '', tool_name: 'Read', tool_use_id: 'r1' })
  const ls = lines()
  assert.strictEqual(ls.length, 2)
  for (const l of ls) {
    assert.strictEqual(l.agent_id, 'main-S1')
    assert.strictEqual(l.agent_type, 'main')
  }
  assert.strictEqual(ls[0].input, 'a')
})

test('2b. main turn: UserPromptSubmit and Stop recorded, prompt summarized', () => {
  reset()
  send({ session_id: 'S1', hook_event_name: 'UserPromptSubmit', prompt: 'a\n  b' })
  send({ session_id: 'S1', hook_event_name: 'Stop', last_assistant_message: 'done' })
  const ls = lines()
  assert.deepStrictEqual(ls.map(l => l.event), ['UserPromptSubmit', 'Stop'])
  assert.strictEqual(ls[0].prompt, 'a b')
  assert.strictEqual(ls[1].message, 'done')
  assert.ok(ls.every(l => l.agent_id === 'main-S1'))
})

test('2c. turn events from inside a subagent are not recorded', () => {
  reset()
  send({ session_id: 'S1', hook_event_name: 'Stop', agent_id: 'x', agent_type: 'tester' })
  send({ session_id: 'S1', hook_event_name: 'UserPromptSubmit', agent_id: 'x', prompt: 'p' })
  assert.strictEqual(lines().length, 0)
})

test('3. unknown agent_type not recorded', () => {
  reset()
  for (const t of ['web-fetch', 'general-purpose', '', undefined]) {
    send({ session_id: 'S1', hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: t })
    send({ session_id: 'S1', hook_event_name: 'PreToolUse', agent_id: 'a', agent_type: t, tool_name: 'Read' })
  }
  assert.strictEqual(lines().length, 0)
})

const inp = ti => { reset(); send({ session_id: 'S1', hook_event_name: 'PreToolUse', agent_id: 'a', agent_type: 'tester', tool_name: 'T', tool_input: ti }); return lines()[0].input }

test('4a. priority file_path > command > pattern', () => {
  assert.strictEqual(inp({ pattern: 'p', command: 'c', file_path: 'f' }), 'f')
  assert.strictEqual(inp({ pattern: 'p', command: 'c' }), 'c')
  assert.strictEqual(inp({ pattern: 'p' }), 'p')
})
test('4b. 160 char truncation', () => {
  assert.strictEqual(inp({ command: 'a'.repeat(160) }), 'a'.repeat(160))
  assert.strictEqual(inp({ command: 'a'.repeat(161) }), 'a'.repeat(160) + '…')
})
test('4c. whitespace collapsed', () => {
  assert.strictEqual(inp({ command: 'a  \n\t b\r\n  c' }), 'a b c')
})
test('4d. no summarizable input -> undefined', () => {
  reset(); send({ session_id: 'S1', hook_event_name: 'PreToolUse', agent_id: 'a', agent_type: 'tester', tool_name: 'T', tool_input: { foo: 1 } })
  assert.strictEqual(lines()[0].input, undefined)
})

test('5. invalid JSON / empty stdin exit 0, no crash, no log', () => {
  reset()
  for (const s of ['', '{not json', 'null', '[]', '"x"']) {
    const r = run(s)
    assert.strictEqual(r.status, 0, JSON.stringify(s) + ' ' + r.stderr)
    assert.strictEqual(r.stderr, '', JSON.stringify(s))
  }
  assert.strictEqual(lines().length, 0)
})


const sz = f => fs.statSync(f).size
const files = () => (fs.existsSync(EVDIR) ? fs.readdirSync(EVDIR).sort() : [])
const start = (sid, extra = {}) => send({ session_id: sid, hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'tester', ...extra })

test('6. log goes to events/<session>.jsonl, no events.jsonl in hook folder', () => {
  reset()
  start('abc-123_X')
  assert.deepStrictEqual(files(), ['abc-123_X.jsonl'])
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, 'events.jsonl')), false)
  assert.strictEqual(lines(path.join(EVDIR, 'abc-123_X.jsonl'))[0].session, 'abc-123_X')
})
test('6b. sessions are separated into different files', () => {
  reset()
  start('A'); start('B'); start('A')
  assert.deepStrictEqual(files(), ['A.jsonl', 'B.jsonl'])
  assert.strictEqual(lines(path.join(EVDIR, 'A.jsonl')).length, 2)
  assert.strictEqual(lines(path.join(EVDIR, 'B.jsonl')).length, 1)
})
test('6c. unsafe chars in session id become _ (no path escape)', () => {
  reset()
  start('a/b\\c:d.e f')
  start('../../evil')
  assert.deepStrictEqual(files(), ['______evil.jsonl', 'a_b_c_d_e_f.jsonl'])
  assert.strictEqual(fs.existsSync(path.join(SANDBOX, '..', 'evil.jsonl')), false)
})
test('6d. missing/empty session -> unknown.jsonl', () => {
  reset()
  send({ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'tester' })
  start('')
  start(null)
  assert.deepStrictEqual(files(), ['unknown.jsonl'])
  assert.strictEqual(lines(path.join(EVDIR, 'unknown.jsonl')).length, 3)
})

test('7. session file > 20MB: not recorded, file left untouched', () => {
  reset()
  fs.mkdirSync(EVDIR, { recursive: true })
  fs.writeFileSync(LOG, '')
  fs.truncateSync(LOG, 20 * MB + 1)
  start('S1')
  send({ session_id: 'S1', hook_event_name: 'PreToolUse', agent_id: 'a', agent_type: 'tester', tool_name: 'Read' })
  assert.strictEqual(sz(LOG), 20 * MB + 1)
})
test('7b. exactly 20MB still recorded (boundary)', () => {
  reset()
  fs.mkdirSync(EVDIR, { recursive: true })
  fs.writeFileSync(LOG, '')
  fs.truncateSync(LOG, 20 * MB)
  start('S1')
  assert.ok(sz(LOG) > 20 * MB)
})
test('7c. between 5MB and 20MB is no longer truncated', () => {
  reset()
  fs.mkdirSync(EVDIR, { recursive: true })
  fs.writeFileSync(LOG, 'x'.repeat(6 * MB))
  start('S1')
  assert.ok(sz(LOG) > 6 * MB)
})
test('7d. one session over the limit does not block other sessions', () => {
  reset()
  fs.mkdirSync(EVDIR, { recursive: true })
  fs.writeFileSync(LOG, '')
  fs.truncateSync(LOG, 21 * MB)
  start('S2')
  assert.strictEqual(lines(path.join(EVDIR, 'S2.jsonl')).length, 1)
})

const endEv = (sid, extra = {}) => send({ session_id: sid, hook_event_name: 'SessionEnd', reason: 'logout', ...extra })

test('8. SessionEnd on existing session file records {ts,event,session,reason}', () => {
  reset()
  start('S1')
  endEv('S1')
  const r = lines()
  assert.strictEqual(r.length, 2)
  assert.deepStrictEqual(Object.keys(r[1]).sort(), ['event', 'reason', 'session', 'ts'])
  assert.strictEqual(r[1].event, 'SessionEnd')
  assert.strictEqual(r[1].session, 'S1')
  assert.strictEqual(r[1].reason, 'logout')
  assert.strictEqual(typeof r[1].ts, 'number')
})
test('8b. SessionEnd without existing file creates nothing (not even events/)', () => {
  reset()
  endEv('S1')
  assert.deepStrictEqual(files(), [])
  assert.strictEqual(fs.existsSync(EVDIR), false)
})
test('8c. SessionEnd only touches its own session file', () => {
  reset()
  start('S1')
  endEv('S2')
  assert.deepStrictEqual(files(), ['S1.jsonl'])
  assert.strictEqual(lines().length, 1)
})
test('8d. SessionEnd ignores agent_type filter (any/none/unknown type, with agent_id)', () => {
  reset()
  start('S1')
  endEv('S1', { agent_type: 'web-fetch' })
  endEv('S1', { agent_type: 'tester', agent_id: 'a' })
  endEv('S1')
  assert.deepStrictEqual(lines().map(x => x.event), ['SubagentStart', 'SessionEnd', 'SessionEnd', 'SessionEnd'])
})
test('8e. SessionEnd without session_id uses unknown.jsonl only if it exists', () => {
  reset()
  send({ hook_event_name: 'SessionEnd', reason: 'x' })
  assert.deepStrictEqual(files(), [])
  send({ hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: 'tester' })
  send({ hook_event_name: 'SessionEnd', reason: 'x' })
  assert.deepStrictEqual(lines(path.join(EVDIR, 'unknown.jsonl')).map(x => x.event), ['SubagentStart', 'SessionEnd'])
})
test('8f. SessionEnd on a >20MB session file is not recorded', () => {
  reset()
  fs.mkdirSync(EVDIR, { recursive: true })
  fs.writeFileSync(LOG, '')
  fs.truncateSync(LOG, 20 * MB + 1)
  endEv('S1')
  assert.strictEqual(sz(LOG), 20 * MB + 1)
})
test('8g. SessionEnd with unsafe session id maps to sanitized file', () => {
  reset()
  start('a/b')
  endEv('a/b')
  assert.deepStrictEqual(lines(path.join(EVDIR, 'a_b.jsonl')).map(x => x.event), ['SubagentStart', 'SessionEnd'])
})

test.after(reset)
