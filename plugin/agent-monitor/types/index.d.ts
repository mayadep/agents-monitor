export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'killed'

export type Run = {
  id: string
  type: string
  description: string
  status: RunStatus
  tool?: string
  toolCount: number
  startedAt: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-monitor': { runs: Shaped<Run[]>; now: Shaped<number> }
  }
}
