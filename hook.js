// Claude Code hook: appends subagent-related events to events/<session>.jsonl
// Records SubagentStart/SubagentStop, and tool calls made inside a subagent.
// It only ever appends: the server alone deletes old session files.
const fs = require('fs')
const path = require('path')

const EVENTS_DIR = path.join(__dirname, 'events')
// A runaway session stops being recorded here rather than filling the disk
const MAX_BYTES = 20 * 1024 * 1024

const logFor = session =>
  path.join(EVENTS_DIR, `${String(session || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`)

const AGENTS_DIR = path.join(require('os').homedir(), '.claude', 'agents')

const globalAgents = () => {
  try {
    return new Set(
      fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)),
    )
  } catch {
    return new Set()
  }
}

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s)

const summarize = input => {
  if (!input || typeof input !== 'object') return undefined
  const v =
    input.file_path ?? input.command ?? input.pattern ?? input.path ??
    input.url ?? input.query ?? input.description ?? input.prompt
  return typeof v === 'string' ? cut(v.replace(/\s+/g, ' '), 160) : undefined
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', c => (raw += c))
process.stdin.on('end', () => {
  try {
    const e = JSON.parse(raw)
    const event = e.hook_event_name
    // Session end marks the session's unfinished runs as stopped; a session
    // that never ran one of the agents has no file and gets none
    if (event === 'SessionEnd') {
      if (fs.existsSync(logFor(e.session_id))) {
        append({ ts: Date.now(), event, session: e.session_id, reason: e.reason })
      }
      return
    }
    // The main conversation is recorded as agent "main", one per session: a
    // prompt starts its turn, Stop ends it, its tool calls carry no agent_id
    const isMain = !e.agent_id
    const isTurn = event === 'UserPromptSubmit' || event === 'Stop'
    if (isTurn && !isMain) return
    if (!isMain || event === 'SubagentStart' || event === 'SubagentStop') {
      // Only the global agents defined in ~/.claude/agents/*.md
      if (!globalAgents().has(e.agent_type)) return
    }

    const rec = {
      ts: Date.now(),
      event,
      session: e.session_id,
      agent_id: isMain ? `main-${e.session_id}` : e.agent_id,
      agent_type: isMain ? 'main' : e.agent_type,
      prompt: cut(typeof e.prompt === 'string' ? e.prompt.replace(/\s+/g, ' ') : undefined, 160),
      tool: e.tool_name,
      tool_use_id: e.tool_use_id,
      input: summarize(e.tool_input),
      failed: event === 'PostToolUseFailure' || undefined,
      message: cut(e.last_assistant_message, 300),
    }
    append(rec)
  } catch {}
})

function append(rec) {
  const log = logFor(rec.session)
  try {
    if (fs.statSync(log).size > MAX_BYTES) return
  } catch {}
  fs.mkdirSync(EVENTS_DIR, { recursive: true })
  fs.appendFileSync(log, JSON.stringify(rec) + '\n')
}
