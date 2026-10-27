import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Run, RunStatus } from '../types'

const PANE = 'agent-monitor'
const TITLE = 'Agents'
const AGENTS = [
  'architect',
  'collector',
  'debugger',
  'docs-writer',
  'implementer',
  'reviewer',
  'tester',
] as const
const TRACKED: ReadonlySet<string> = new Set(AGENTS)
const ENDED: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'killed'])

// Change the tag when a run's fields change: it declines what an earlier
// version stored, which outlives a reload.
const runs = atom({ plugin: 'agent-monitor', key: 'runs' } as const, [], {
  shape: 'runs-1',
})
const now = atom({ plugin: 'agent-monitor', key: 'now' } as const, 0, {
  shape: 'now-1',
})

const LABEL: Record<RunStatus, string> = {
  pending: '대기',
  running: '실행',
  waiting: '보류',
  idle: '유휴',
  completed: '완료',
  failed: '실패',
  killed: '중지',
}
const ICON: Record<RunStatus, string> = {
  pending: '○',
  running: '●',
  waiting: '◐',
  idle: '◌',
  completed: '✓',
  failed: '✗',
  killed: '■',
}
const COLOR: Record<RunStatus, string> = {
  pending: 'subtle',
  running: 'suggestion',
  waiting: 'warning',
  idle: 'subtle',
  completed: 'success',
  failed: 'error',
  killed: 'warning',
}

const elapsed = (run: Run, at: number) => {
  const sec = Math.max(0, Math.floor(((run.endedAt ?? at) - run.startedAt) / 1000))
  const m = Math.floor(sec / 60)

  return m > 0 ? `${m}m${String(sec % 60).padStart(2, '0')}s` : `${sec}s`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agents-pane',
      description: 'Show the live status of the global subagents in a pane',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    // Once a second while anything runs: sync statuses from the engine's
    // agent list and move the clock the elapsed times are drawn from.
    $.clock.every(1000, async () => {
      const list = await read($, runs)
      if (!list.some(run => !ENDED.has(run.status))) return

      const at = await $.clock.now()
      const live = new Map((await $.agent.list()).map(info => [info.id, info.status]))
      await update($, runs, all =>
        all.map(run => {
          const status = live.get(run.id)
          if (status === undefined || status === run.status) return run
          const isEnded = ENDED.has(status)

          return {
            ...run,
            status,
            tool: isEnded ? undefined : run.tool,
            endedAt: isEnded ? at : undefined,
          }
        }),
      )
      await update($, now, () => at)
    })

    return next(e)
  })

  on('command.run', { command: 'agents-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Agents pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.agentId === undefined || !TRACKED.has(e.subagentType)) return ran

    const at = await $.clock.now()
    const run: Run = {
      id: ran.agentId,
      type: e.subagentType,
      description: e.description,
      status: 'running',
      toolCount: 0,
      startedAt: at,
    }
    await update($, runs, list => [...list, run].slice(-100))
    await update($, now, () => at)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined || !(await read($, runs)).some(run => run.id === id)) {
      return next(e)
    }

    await update($, runs, list =>
      list.map(run =>
        run.id === id ? { ...run, tool: e.tool, toolCount: run.toolCount + 1 } : run,
      ),
    )
    const ran = await next(e)
    await update($, runs, list =>
      list.map(run =>
        run.id === id && run.tool === e.tool ? { ...run, tool: undefined } : run,
      ),
    )

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const at = await read($, now)
    const active = list.filter(run => !ENDED.has(run.status)).length

    return (
      <Box flexDirection="column">
        <Text dimColor>
          실행 중 {active} · 총 {list.length}회
        </Text>
        {AGENTS.map(name => {
          const mine = list.filter(run => run.type === name)
          const last = mine[mine.length - 1]
          if (last === undefined) {
            return (
              <Box flexDirection="column" marginTop={1}>
                <Text dimColor>
                  ○ {name.padEnd(12)} 대기
                </Text>
              </Box>
            )
          }

          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={COLOR[last.status]} weight="bold">
                {ICON[last.status]} {name.padEnd(12)} {LABEL[last.status]} {elapsed(last, at)}
                {mine.length > 1 ? ` ×${mine.length}` : ''}
              </Text>
              <Text dimColor wrap="truncate-end">
                {'  '}
                {last.tool !== undefined ? `▸ ${last.tool} · ` : ''}
                도구 {last.toolCount}회 · {last.description}
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}
