import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import type { Agent, AgentPick, Graphify } from '../types'
import * as pony from './ponytail'

const graphify = atom({ plugin: 'penguin', key: 'graphify' } as const, { installed: null, busy: null, watching: false } as Graphify)

// How many times Claude queried the graph (graphify MCP tool calls) in this session.
const graphQueries = atom({ plugin: 'penguin', key: 'graphQueries' } as const, 0)

// Compact (one row) or detailed band; the choice is kept across sessions in $.store.
const compact = atom({ plugin: 'penguin', key: 'compact' } as const, false)

// Which tools show on the bar ({ graphify: false } hides it); absent = shown. Source of truth is the settings file.
const enabled = atom({ plugin: 'penguin', key: 'enabled' } as const, {} as Record<string, boolean>)

// Which stats each tool shows on the bar ({ ponytail: { cost: false } }); absent = shown. Also from the settings file.
const barStats = atom({ plugin: 'penguin', key: 'barStats' } as const, {} as Record<string, Record<string, boolean>>)

// Ponytail's own band state: it keeps counting while its band is hidden, so PENGUIN draws from it.
const ponytailBand = { plugin: 'ponytail', key: 'band' } as const

// The subagents in ~/.claude/agents (agency-agents installs its roster there), read at session start and after an install.
const agents = atom({ plugin: 'penguin', key: 'agents' } as const, [] as Agent[])
const agentPick = atom({ plugin: 'penguin', key: 'agentPick' } as const, { group: '', agent: '' } as AgentPick)

// "engineering-frontend-developer.md:name: Frontend Developer" lines → agents grouped by the file's first word;
// a first word fewer than 3 agents share goes under "other".
// The most options a Select takes; one more and the engine refuses the whole band, not just the dropdown.
const MAX_OPTIONS = 64

function parseAgents(grepOut: string): Agent[] {
  const rows = grepOut.split('\n').flatMap(line => {
    const m = /([^/]+?)\.md:name:\s*["']?(.+?)["']?\s*$/.exec(line)
    return m ? [{ stem: m[1] ?? '', name: m[2] ?? '' }] : []
  })
  const first = (stem: string) => stem.split('-')[0] ?? stem
  const count = new Map<string, number>()
  for (const r of rows) count.set(first(r.stem), (count.get(first(r.stem)) ?? 0) + 1)
  const sorted = rows
    .map(r => ({ name: r.name, file: `${r.stem}.md`, group: (count.get(first(r.stem)) ?? 0) >= 3 ? first(r.stem) : 'other' }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  // A Select takes at most 64 options, and one over that makes the engine refuse the whole band: a bigger division
  // is split into "engineering 1", "engineering 2", … of up to 64 agents each, in name order.
  const size = new Map<string, number>()
  for (const a of sorted) size.set(a.group, (size.get(a.group) ?? 0) + 1)
  const seen = new Map<string, number>()
  return sorted.map(a => {
    const i = seen.get(a.group) ?? 0
    seen.set(a.group, i + 1)
    return (size.get(a.group) ?? 0) > MAX_OPTIONS ? { ...a, group: `${a.group} ${Math.floor(i / MAX_OPTIONS) + 1}` } : a
  })
}

const claudeDir = async ($: EngineInterface) => (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`

async function loadAgents($: EngineInterface) {
  // One grep for every file's name line: hundreds of $.fs.read calls would be slower.
  const r = await sh($, 'grep -m1 -H "^name:" "$1"/agents/*.md 2>/dev/null', [await claudeDir($)]).catch(() => ({ stdout: '' }))
  await update($, agents, () => parseAgents(r.stdout))
}

// Copies the agent's file into this project's .claude/agents, so the project carries its own copy. A file already
// there is left alone (it may hold the project's own edits); the settings page offers to keep the copies out of git.
async function copyAgent($: EngineInterface, a: Agent) {
  const dest = `${await $.session.cwd()}/.claude/agents/${a.file}`
  if (await $.fs.exists(dest).catch(() => true)) return // also when the session's folder is home: source and copy coincide
  try {
    await $.fs.write(dest, await $.fs.read(`${await claudeDir($)}/agents/${a.file}`))
    $.ui.toast(`Copied ${a.name} into this project's .claude/agents`)
  } catch (err) {
    $.ui.toast(`Couldn't copy ${a.name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Puts "Use the <agent> agent to " in front of whatever is typed; the person writes the task and sends it.
async function useAgent($: EngineInterface, a: Agent) {
  await copyAgent($, a)
  const { text } = await $.prompt.read()
  const done = await $.prompt.fill({ text: `Use the ${a.name} agent to ${text}` })
  if (!done.isFilled) $.ui.toast(`Couldn't fill the prompt: ask Claude to "use the ${a.name} agent"`)
}

const AUTO = 'Use the most suitable agent to '

// Armed by a sent prompt that starts with AUTO: the first agency agent Claude then calls is shown in the dropdowns
// and copied into the project, as Use would. Any other prompt disarms it.
// shortcut: a module variable, so a plugin reload between sending and the call forgets it; the agent still runs.
let autoPending = false

// Puts AUTO in front of whatever is typed: Claude picks the agent for the task.
async function autoAgent($: EngineInterface) {
  const { text } = await $.prompt.read()
  const done = await $.prompt.fill({ text: `${AUTO}${text}` })
  if (!done.isFilled) $.ui.toast("Couldn't fill the prompt: ask Claude to use the most suitable agent")
}

// Ponytail's own commands, so its skills stay the only logic (what its band's buttons run).
const ponytailRun = ($: EngineInterface, command: string, args = '') => $.command.run({ command, args })

// Ponytail rebuilds its board after every turn; open the file it wrote.
// shortcut: shows the board as of the last turn; Ponytail's own Board button rebuilds it first.
async function openPonytailBoard($: EngineInterface) {
  const dir = (await $.env.get('XDG_CONFIG_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.config`
  const r = await sh($, '[ -f "$1" ] || exit 2; open "$1" 2>/dev/null || xdg-open "$1"', [`${dir}/ponytail/band/board.html`])
  if (r.exitCode === 2) $.ui.toast('No Ponytail board yet: it is written after your first turn')
  else if (r.exitCode !== 0) $.ui.toast('Could not open the Ponytail board')
}

const settingsFile = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? ''}/.config/penguin/settings.json`

type Settings = { enabled?: Record<string, boolean>; stats?: Record<string, Record<string, boolean>> }

async function applySettings($: EngineInterface, data: Settings) {
  await update($, enabled, () => data.enabled ?? {})
  await update($, barStats, () => data.stats ?? {})
}

async function loadEnabled($: EngineInterface) {
  let data: Settings = {}
  try {
    data = JSON.parse(await $.fs.read(await settingsFile($))) as Settings
  } catch {}
  await applySettings($, data)
}

// The settings page's local server; one per module, killed when the module unloads (a reload) or the loop ends.
let server: { url: string; cwd: string; stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> } | null = null

async function startServer($: EngineInterface): Promise<string> {
  // The page's per-project options act on the session's folder, so a server started in another folder is replaced.
  const cwd = await $.session.cwd()
  if (server?.cwd === cwd) return server.url
  if (server) {
    void server.stream.return({ code: null, signal: 'SIGTERM' })
    server = null
  }
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const token = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  const stream = $.process.spawn({
    argv: ['python3', '-I', `${$.plugin.root}/server/settings_server.py`, token, await settingsFile($), cwd],
    env: { PATH: await shPath($) },
  })
  return new Promise<string>((resolve, reject) => {
    let buffer = ''
    let started = false
    void (async () => {
      try {
        for await (const { stream: from, text } of stream) {
          if (from === 'stderr') {
            $.ui.log(text, { to: 'debug' })
            continue
          }
          buffer += text
          let nl: number
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line.startsWith('PORT ') && !started) {
              started = true
              // The token rides in the fragment: never sent to the server in a request line or a Referer.
              const url = `http://127.0.0.1:${line.slice(5)}/#t=${token}`
              server = { url, cwd, stream }
              resolve(url)
            } else if (line.startsWith('SETTINGS ')) {
              await applySettings($, JSON.parse(line.slice(9)) as Settings)
            } else if (line === 'INSTALLED agency') {
              await loadAgents($)
            } else if (line.startsWith('INSTALLED ')) {
              const installed = await isInstalled($)
              // Uninstalled from the page: a running `graphify watch` has nothing left to run.
              if (!installed && watcher) {
                stopping = true
                void watcher.return({ code: null, signal: 'SIGTERM' })
              }
              await update($, graphify, g => ({ ...g, installed, error: null }))
            } else if (line.startsWith('OUTPUT_DELETED ')) {
              await measure($, await $.session.cwd()) // no report left: the bar shows "No graph yet"
            }
          }
        }
      } catch (err) {
        if (!started) reject(err)
      } finally {
        // Only forget the server if it is still this one, not a replacement started for another folder.
        if (server?.stream === stream) server = null
        if (!started) reject(new Error('settings server exited before it started (is python3 installed?)'))
      }
    })()
  })
}

async function openSettings($: EngineInterface) {
  try {
    const url = await startServer($)
    await sh($, 'open "$1" 2>/dev/null || xdg-open "$1"', [url])
  } catch (err) {
    $.ui.toast(`PENGUIN settings: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// The plugin's process may not see the user's shell PATH; uv/pipx tools land in ~/.local/bin.
async function shPath($: EngineInterface) {
  const home = (await $.env.get('HOME')) ?? ''
  return `${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${(await $.env.get('PATH')) ?? '/usr/bin:/bin'}`
}

async function sh($: EngineInterface, script: string, args: string[] = [], timeoutMs = 30_000) {
  return $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { env: { PATH: await shPath($) }, timeoutMs })
}

// The running `graphify watch`; it dies with the module (a reload), so the button reads this, not stored state.
let stopping = false
let watcher: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null = null

async function toggleWatch($: EngineInterface) {
  if (watcher) {
    stopping = true
    void watcher.return({ code: null, signal: 'SIGTERM' }) // ends the loop below, which kills the child
    return
  }
  stopping = false
  let lastErr = ''
  const cwd = await $.session.cwd()
  // shortcut: watches the folder the session is in when pressed; a later cd keeps watching the old one.
  const stream = $.process.spawn({
    argv: ['/bin/sh', '-c', 'exec graphify watch "$1"', 'sh', cwd],
    env: { PATH: await shPath($) },
  })
  watcher = stream
  await update($, graphify, g => ({ ...g, watching: true, error: null }))
  $.ui.toast(`Auto Rebuild Graph on: ${cwd}`)
  void (async () => {
    try {
      for await (const { stream: from, text } of stream) {
        if (from === 'stderr') lastErr = text.trim().split('\n').pop() ?? lastErr
        $.ui.log(text, { to: 'debug' })
        // graphify watch prints "[graphify watch] Rebuilt: N nodes…" after each rebuild: refresh the bar's figures.
        if (text.includes('Rebuilt:')) void measure($, cwd).catch(() => {})
      }
      if (!stopping) {
        const error = `watch stopped${lastErr ? `: ${lastErr}` : ''}`
        await update($, graphify, g => ({ ...g, error }))
        $.ui.toast(`Graphify ${error}`)
      }
    } catch (err) {
      const error = `watch failed: ${err instanceof Error ? err.message : String(err)}`
      await update($, graphify, g => ({ ...g, error }))
      $.ui.toast(`Graphify ${error}`)
    } finally {
      watcher = null
      await update($, graphify, g => ({ ...g, watching: false }))
    }
  })()
}

const isInstalled = async ($: EngineInterface) =>
  (await sh($, 'command -v graphify').catch(() => ({ exitCode: 1 }))).exitCode === 0

// Runs one job at a time and reports failure as a toast instead of throwing into the band.
// A thrown error is a failure: it turns the status dot red until the next job succeeds.
async function job($: EngineInterface, label: string, work: () => Promise<string | undefined>) {
  if ((await read($, graphify)).busy) return
  await update($, graphify, g => ({ ...g, busy: label }))
  try {
    const msg = await work()
    await update($, graphify, g => ({ ...g, error: null }))
    if (msg) $.ui.toast(msg)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await update($, graphify, g => ({ ...g, error }))
    $.ui.toast(`Graphify: ${error}`)
  } finally {
    await update($, graphify, g => ({ ...g, busy: null }))
  }
}

const optimise = ($: EngineInterface) =>
  job($, 'Rebuilding graph…', async () => {
    const cwd = await $.session.cwd()
    const r = await sh($, 'graphify update "$1"', [cwd], 600_000)
    if (r.exitCode !== 0) throw new Error(`build failed: ${r.stderr.trim().split('\n').pop() ?? `exit ${r.exitCode}`}`)
    await measure($, cwd)
    // Graphify is on but nothing could connect Claude before a graph existed: connect now. `claude mcp get` first,
    // so a graphify server the user set up in any scope is left as it is. A failed connect isn't a failed build.
    if ((await read($, enabled)).graphify !== false) {
      const c = await sh(
        $,
        'cd "$1" && claude mcp get graphify >/dev/null 2>&1 && exit 3; ' +
          'claude mcp add graphify --scope local -- "$(command -v graphify-mcp)" "$1/graphify-out/graph.json"',
        [cwd],
        90_000,
      ).catch(() => ({ exitCode: 1 }))
      if (c.exitCode === 0) return `Graph built and connected: new sessions here can query it`
    }
    return `Graph built in ${cwd}/graphify-out`
  })

const tokens = (chars: number) => Math.round(chars / 4) // graphify's own chars-per-token estimate

// Estimate: reading the whole project vs one graph query. Corpus = report's word count (100 words ≈ 133 tokens);
// query = average `graphify query` answer for the top 3 hub nodes. Not a record of tokens actually spent.
async function measure($: EngineInterface, cwd: string) {
  let report: string
  try {
    report = await $.fs.read(`${cwd}/graphify-out/GRAPH_REPORT.md`)
  } catch {
    return update($, graphify, g => ({ ...g, stats: { cwd, corpus: 0, query: 0 } }))
  }
  const words = Number(/~([\d,]+) words/.exec(report)?.[1]?.replaceAll(',', '') ?? 0)
  const hubs = await sh($, 'cd "$1" && graphify god-nodes --json --top 3', [cwd])
  let labels: string[] = []
  try {
    labels = (JSON.parse(hubs.stdout) as { label: string }[]).map(n => n.label)
  } catch {}
  // graphify query exits non-zero when a name matches nothing or is ambiguous; those answers aren't real queries.
  const runs = await Promise.all(labels.map(l => sh($, 'cd "$1" && graphify query "$2"', [cwd, l])))
  const sizes = runs.filter(r => r.exitCode === 0).map(r => r.stdout.length)
  const query = sizes.length ? tokens(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0
  await update($, graphify, g => ({ ...g, stats: { cwd, corpus: Math.round((words * 4) / 3), query } }))
}

const fmt = (n: number) => n.toLocaleString('en-US')



const openGraph = ($: EngineInterface) =>
  job($, 'Opening…', async () => {
    const file = `${await $.session.cwd()}/graphify-out/graph.html`
    const r = await sh($, '[ -f "$1" ] || exit 2; open "$1" 2>/dev/null || xdg-open "$1"', [file])
    if (r.exitCode === 2) return 'No graph yet: press Optimise first'
    if (r.exitCode !== 0) throw new Error(`could not open ${file}`)
    return undefined
  })

// Drawing can't write state, so the figures are measured outside it: at session start (a reload runs it too), and
// on a prompt sent from a folder not measured yet. shortcut: a cd shows the old folder's figures until then.
let measuring = ''

// The logo the settings page shows (assets/logo.svg), read at session start; the desktop toolbar draws it.
let logo = ''
async function remeasure($: EngineInterface) {
  const cwd = await $.session.cwd()
  if (measuring === cwd || !(await read($, graphify)).installed) return
  measuring = cwd
  void measure($, cwd).catch(() => {})
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    await remeasure($).catch(() => {})
    autoPending = e.text.startsWith(AUTO)
    return next(e)
  })

  // Counts the times Claude really asked the graph this session: calls to the `graphify` MCP server's tools.
  on('tool.call', async ($, e, next) => {
    // After Auto: the agent Claude chose becomes the dropdowns' pick and is copied in. Never fails the call.
    if (autoPending && e.tool === 'Agent' && e.subagent_type) {
      const name = e.subagent_type
      try {
        const a = (await read($, agents)).find(x => x.name === name)
        if (a) {
          autoPending = false
          await update($, agentPick, () => ({ group: a.group, agent: a.name }))
          await copyAgent($, a)
        }
      } catch {}
    }
    const result = await next(e)
    // Never throw after the tool has run: a failed count must not fail (or re-run) Claude's call.
    if (e.tool.startsWith('mcp__graphify__')) await update($, graphQueries, n => n + 1).catch(() => {})
    return result
  })

  on('session.start', async ($, e, next) => {
    const installed = await isInstalled($)
    await update($, graphify, g => ({ ...g, installed }))
    const saved = (await $.store.get('compact')) === true
    await update($, compact, () => saved)
    await loadEnabled($)
    await loadAgents($)
    logo = await $.fs.read(`${$.plugin.root}/assets/logo.svg`).catch(() => '')
    measuring = ''
    await remeasure($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text, Button, Link } = $.ui.resolve(e)
    // Desktop draws the logo file; the terminal (text only) and a missing file keep the 🐧.
    const drawLogo = e.surface === 'desktop' && logo !== ''
    const { Svg } = $.ui.resolve(e)
    const title = (
      <Box flexDirection="row" alignItems="center" gap="xs">
        {drawLogo && <Svg source={logo} alt="" width={18} height={18} />}
        <Link href="https://github.com/shaiksajid-in/penguin">
          {/* An explicit colour on the text overrides the surface's link colour. */}
          <Text weight="semibold" color="text">{drawLogo ? 'PENGUIN' : '🐧 PENGUIN'}</Text>
        </Link>
      </Box>
    )
    const g = await read($, graphify)
    const cwd = await $.session.cwd()

    const isWatching = Boolean(g.watching && watcher)

    // Icon button whose tooltip pill covers the card's heading while hovered (no hook runs).
    const icon = (id: string, glyph: string, onPress: () => unknown, primary = false, big = false) => (
      <Box key={`wrap-${id}`} hover={{ scope: `tip-${id}` }}>
        <Button key={id} variant={primary ? 'primary' : 'secondary'} onPress={onPress}>
          <Text size={big ? 'heading' : 'body'}>{glyph}</Text>
        </Button>
      </Box>
    )
    const tip = (id: string, text: string, side: 'left' | 'right' = 'left') => (
      <Box
        key={`tip-${id}`}
        position="absolute"
        top={0}
        {...(side === 'left' ? { left: 0 } : { right: 0 })}
        display="none"
        hover={{ scope: `tip-${id}`, display: 'flex' }}
        backgroundColor="text"
      >
        <Text color="inverseText" size="caption" weight="medium">
          {' '}{text}{' '}
        </Text>
      </Box>
    )

    const st = g.stats
    const saved = st && st.corpus && st.query ? st.corpus - st.query : 0

    const isCompact = await read($, compact)
    const toggleView = async () => {
      await update($, compact, c => !c)
      await $.store.set('compact', !isCompact)
    }
    // Installing happens on the settings page; the bar shows Graphify only once it is installed and switched on.
    const shown = await read($, enabled)
    const graphifyOn = g.installed === true && shown.graphify !== false
    // Ponytail has written its band state only if it is installed and running in this session.
    const raw = shown.ponytail === false ? undefined : (await $.state.get(ponytailBand)).value
    const pt = raw && { ...pony.EMPTY, ...raw } // an older Ponytail may lack newer fields
    const ponytailOn = pt !== undefined
    const roster = shown.agency === false ? [] : await read($, agents)
    const anyOn = graphifyOn || ponytailOn || roster.length > 0
    const ratio = st && st.query ? (st.corpus / st.query).toFixed(1) : ''

    // One status beside the GRAPHIFY title: a running job first, then Watch, then whether this folder has a graph.
    const hasGraph = Boolean(st && st.cwd === cwd && st.corpus)
    const used = await read($, graphQueries)
    // Connected = Claude has the graphify MCP tools in this session (or has already used them).
    // shortcut: a tool list that holds MCP tools back (tool search) can hide them; a first query then proves it.
    const connected =
      used > 0 || (await $.tool.list().catch(() => [])).some(t => t.name.startsWith('mcp__graphify__'))
    // The dot is health only: red after a failure (until the next success); orange when there is a graph but this
    // session can't query it; green when connected and working. The label beside it says what is going on.
    const dot = g.error ? 'error' : hasGraph && !connected ? 'warning' : 'success'
    // Live figures: tokens one graph query saves (see measure()), how many times fewer, Claude's graph queries this
    // session, and the total those queries saved. Hovering the label explains each.
    const stats = hasGraph
      ? saved > 0
        ? `${fmt(saved)} tok/q · ${ratio}× · ⌕ ${used}${used > 0 ? ` · Σ ${fmt(used * saved)}` : ''}`
        : `Graph ready · ⌕ ${used}`
      : 'No graph yet · press ↻'
    const label = g.busy ? g.busy : g.error ? g.error : isWatching ? `Auto Rebuild Graph · ${stats}` : stats
    // The buttons stay put while a job runs (job() ignores a second press); the status says what is happening.
    const controls = (
      <Box flexDirection="row" gap="xs" alignItems="center">
        {icon('optimise', '↻', () => optimise($), false, true)}
        {icon('watch', isWatching ? '■' : '▷', () => toggleWatch($))}
        <Text dimColor>│</Text>
        {icon('graph', '↗', () => openGraph($))}
      </Box>
    )
    // A bare glyph with no button chrome: dim at rest, full strength under the pointer.
    const viewButton = (
      <Box key="wrap-view" hover={{ scope: 'tip-view' }}>
        <Button key="view" plain dimColor onPress={toggleView}>
          <Text size="heading">{isCompact ? '⋯' : '×'}</Text>
        </Button>
      </Box>
    )
    // Title on the left; on the right the view toggle, or, while no tool is on the bar (none installed, or all
    // switched off), a download button that opens the settings page. Tooltips show over the title.
    const header = (
      <Box position="relative" flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexDirection="row" gap={0} alignItems="center">
          {title}
          {/* Settings: a bare glyph like the view toggle; its tooltip shows on the right, clear of the button.
              Hidden while ⤓ shows, since ⤓ opens the same page. */}
          {anyOn && (
            <Box key="wrap-settings" hover={{ scope: 'tip-settings' }}>
              <Button key="settings" plain dimColor onPress={() => openSettings($)}>
                <Text size="heading">⚒︎</Text>
              </Button>
            </Box>
          )}
        </Box>
        {anyOn ? viewButton : icon('install', '⤓', () => openSettings($), true)}
        {tip('settings', 'Settings', 'right')}
        {tip('install', g.installed ? 'Enable tools' : 'Install')}
        {tip('view', isCompact ? 'Detailed view' : 'Compact view')}
      </Box>
    )
    const tips = [
      tip('optimise', 'Optimise · build the code graph for this folder'),
      tip('graph', 'Graph · open the interactive graph in your browser'),
      tip('watch', isWatching ? 'Watch is on · click to stop' : 'Watch · rebuild the graph as files change'),
    ]

    if (isCompact) return header

    // Ponytail's section, drawn like Ponytail's own band in its details view.
    let ponytailSection = null
    if (pt) {
      const cols = pony.detailCols(pt, (await read($, barStats)).ponytail ?? {})
      const copy = async () => {
        const done = await $.ui.copy({ text: pony.markdown(pt, cols), surface: e.surface })
        $.ui.toast(done.isCopied ? 'Ponytail stats copied as Markdown' : `Copy failed: ${done.reason}`)
      }
      // Text glyphs make broken lines in the desktop's proportional font; Ponytail draws an SVG there.
      const metrics =
        e.surface === 'desktop' ? (
          (() => {
            const { Svg } = $.ui.resolve(e)
            return <Svg source={pony.metricsSvg(cols, pt.turnCosts)} alt={cols.map(c => `${c.label} ${c.value}`).join(', ')} />
          })()
        ) : (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {'─'.repeat(e.props.bodyColumns)}
            </Text>
            <Box flexDirection="row" gap={2}>
              {cols.map(c => (
                <Box key={`pt-col-${c.key}`} flexDirection="column" flexGrow={1}>
                  <Text dimColor>{c.label}</Text>
                  <Text bold color={c.tone}>
                    {c.value}
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {c.sub}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )
      ponytailSection = (
        // A small gap on desktop between the buttons and the metrics; the terminal has its ─ rule there instead.
        <Box flexDirection="column" borderStyle="round" borderDimColor gap={e.surface === 'desktop' ? 'xs' : 0}>
          <Box position="relative" flexDirection="row" alignItems="center" gap={1}>
            {/* The section's name, as GRAPHIFY and AGENCY have theirs. */}
            <Link href="https://github.com/DietrichGebert/ponytail">
              <Text size="caption" weight="medium" color="text" dimColor>
                PONYTAIL
              </Text>
            </Link>
            {pony.LEVELS.map(level => (
              <Button
                key={`pt-level-${level}`}
                // Shown capitalised; the command still gets the lowercase level. The ✓ marks the current one in words.
                label={`${level === pt.level ? '✓ ' : ''}${level.charAt(0).toUpperCase()}${level.slice(1)}`}
                variant="secondary"
                onPress={() => ponytailRun($, 'ponytail:ponytail', level)}
              />
            ))}
            <Box flexGrow={1} />
            {/* Review and Audit, then │, then Copy and Board as icons (names in their tooltips, like Graphify's). */}
            <Button key="pt-review" variant="secondary" label="Review" onPress={() => ponytailRun($, 'ponytail:ponytail-review')} />
            <Button key="pt-audit" variant="secondary" label="Audit" onPress={() => ponytailRun($, 'ponytail:ponytail-audit')} />
            <Text dimColor>│</Text>
            {icon('pt-copy', '⧉', copy)}
            {icon('pt-board', '▦', () => openPonytailBoard($))}
            {tip('pt-copy', 'Copy · the stats as a Markdown table')}
            {tip('pt-board', 'Board · every tracked session, in your browser')}
          </Box>
          {cols.length > 0 && metrics}
        </Box>
      )
    }

    // AGENCY: pick a division, then an agent, and Use puts "Use the <agent> agent to " in the prompt box.
    let agencySection = null
    if (roster.length > 0) {
      const { Select } = $.ui.resolve(e)
      const pick = await read($, agentPick)
      // shortcut: past 64 divisions the rest are left out of the list; group by fewer words if that ever happens.
      const groups = [...new Set(roster.map(a => a.group))].slice(0, MAX_OPTIONS)
      const group = groups.includes(pick.group) ? pick.group : (groups[0] ?? '')
      const inGroup = roster.filter(a => a.group === group)
      const agent = inGroup.find(a => a.name === pick.agent) ?? inGroup[0]
      const titled = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
      agencySection = (
        <Box flexDirection="row" alignItems="center" gap={1} borderStyle="round" borderDimColor>
          <Link href="https://github.com/msitarzewski/agency-agents">
            <Text size="caption" weight="medium" color="text" dimColor>
              AGENCY
            </Text>
          </Link>
          <Select
            key="agency-group"
            options={groups.map(g => ({ value: g, label: titled(g) }))}
            value={group}
            onSelect={value => update($, agentPick, () => ({ group: value, agent: '' }))}
          />
          <Text dimColor>→</Text>
          <Select
            key="agency-agent"
            options={inGroup.map(a => ({ value: a.name, label: a.name }))}
            value={agent?.name ?? ''}
            onSelect={value => update($, agentPick, () => ({ group, agent: value }))}
          />
          <Box flexGrow={1} />
          {/* Auto leaves the choice to Claude, which matches the task against every agent's description itself. */}
          <Button key="agency-auto" label="Auto" onPress={() => autoAgent($)} />
          {agent && <Button key="agency-use" label="Use" onPress={() => useAgent($, agent)} />}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap="xs">
        {header}

        {ponytailSection}

        {graphifyOn && (
        <Box flexDirection="column" borderStyle="round" borderDimColor gap="xs">
          <Box position="relative" flexDirection="row" justifyContent="space-between" alignItems="center">
            <Box flexDirection="row">
              <Link href="https://github.com/Graphify-Labs/graphify">
                <Text size="caption" weight="medium" color="text" dimColor>
                  GRAPHIFY
                </Text>
              </Link>
              <Box key="wrap-dot" hover={{ scope: 'tip-dot' }}>
                <Text size="caption" color={dot}>
                  {'  • '}
                </Text>
              </Box>
              <Box key="wrap-stats" hover={{ scope: 'tip-stats' }}>
                <Text size="caption" weight="medium" dimColor={!g.error} color={g.error ? 'error' : undefined}>
                  {label}
                </Text>
              </Box>
            </Box>
            {controls}
            {tips}
            {tip(
              'dot',
              g.error
                ? 'Something failed · the next successful action clears it'
                : hasGraph && !connected
                  ? 'Graph not connected to this session · Connect it in ⚒ settings, then start a new session'
                  : 'Working',
              'right',
            )}
            {hasGraph &&
              tip('stats', 'tok/q: tokens saved per question · ×: fewer tokens · ⌕: Claude graph queries · Σ: total saved', 'right')}
          </Box>
        </Box>
        )}

        {agencySection}
      </Box>
    )
  })
}
