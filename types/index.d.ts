// installed: null while the first check runs. busy: label of the running job, or null. watching: graphify watch is running. error: the last failure, cleared by the next success. stats: estimated tokens to read the project (corpus) vs one graph query.
export type Graphify = { installed: boolean | null; busy: string | null; watching?: boolean; error?: string | null; stats?: { cwd: string; corpus: number; query: number } | null }

// The part of Ponytail's own band state PENGUIN reads (Ponytail owns and writes it; any plugin may read it).
export type PonytailBand = {
  level: string
  spent: number
  turns: number
  turnCosts: number[]
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
  busyMs: number
  reused: string[]
  created: string[]
  openCallers: string[]
  tests: { state: 'none' | 'pass' | 'fail' | 'stale'; passed?: number; failed?: number }
}

// Per tool, which stats show on the bar ({ ponytail: { cost: false } } hides cost); absent = shown.
export type BarStats = { [tool: string]: { [stat: string]: boolean } }

// A subagent in ~/.claude/agents: its name (what Claude calls it by), its file there, and its division (the file name's first word).
export type Agent = { name: string; file: string; group: string }
// The AGENCY section's picks: a division, then an agent in it ('' = engineering and AI Engineer where present, else the first).
export type AgentPick = { group: string; agent: string }

declare module 'claude-code' {
  interface PluginState {
    penguin: { graphify: Graphify; compact: boolean; enabled: Record<string, boolean>; barStats: BarStats; graphQueries: number; agents: Agent[]; agentPick: AgentPick }
    ponytail: { band: PonytailBand }
  }
}
