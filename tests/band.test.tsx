import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'penguin',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const CWD = '/proj'
// graphify's report says ~3,000 words (≈ 4,000 tokens); each hub query answers 400 chars (100 tokens).
const REPORT = '# Graph report\n~3,000 words\n'

// The engine beneath PENGUIN: a folder, graphify on PATH or not, and a graph built or not.
function world(on: On, { installed, graph, settings, agents = '', logo = '' }: { installed: boolean; graph: boolean; settings?: object; agents?: string; logo?: string }) {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/u', PATH: '/usr/bin:/bin' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('tool.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  on('fs.read', (_, e) => {
    if (graph && e.path === `${CWD}/graphify-out/GRAPH_REPORT.md`) return { value: REPORT }
    if (settings && e.path === '/home/u/.config/penguin/settings.json') return { value: JSON.stringify(settings) }
    if (e.path.startsWith('/home/u/.claude/agents/')) return { value: `agent ${e.path.split('/').pop()}` }
    if (logo && e.path.endsWith('/assets/logo.svg')) return { value: logo }
    return { deny: 'ENOENT' }
  })
  on('process.run', (_, e) => {
    const script = e.argv[2] ?? ''
    const out = (exitCode: number, stdout = '') => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    if (script === 'command -v graphify') return out(installed ? 0 : 1)
    if (script.includes('^name:')) return out(agents ? 0 : 2, agents)
    if (script.includes('god-nodes')) return out(0, JSON.stringify([{ label: 'a' }, { label: 'b' }, { label: 'c' }]))
    if (script.includes('graphify query')) return out(0, 'x'.repeat(400))
    return out(1)
  })
  return clock
}

const SURFACES = ['terminal', 'desktop'] as const

test('without graphify the band offers the install page and no Graphify card', async ($, on) => {
  world(on, { installed: false, graph: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /PENGUIN/ })).toBeDefined()
    expect(await ui.find({ key: 'install' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /GRAPHIFY/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('with graphify but no graph the card says so', async ($, on) => {
  world(on, { installed: true, graph: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /GRAPHIFY/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /No graph yet/ }))?.text).toBe('No graph yet · press ↻')
    expect(await ui.find({ key: 'install' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a built graph shows the estimate, and graph queries are counted', async ($, on) => {
  const clock = world(on, { installed: true, graph: true })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  await clock.settle() // measuring runs unawaited from session.start

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /tok\/q/ }))?.text).toBe('3,900 tok/q · 40.0× · ⌕ 0')

  await $.tool.call({ tool: 'mcp__graphify__query_graph', question: 'x' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /tok\/q/ }))?.text).toBe('3,900 tok/q · 40.0× · ⌕ 1 · Σ 3,900')
  await ui.unmount()
})

test('the view toggle collapses the band to its header and back', async ($, on) => {
  world(on, { installed: true, graph: false })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /GRAPHIFY/ })).toBeUndefined()
    await ui.press({ key: 'view' })
    expect(await ui.find({ type: 'Text', text: /GRAPHIFY/ })).toBeDefined()
    await ui.unmount()
  }
})

// Ponytail's band state mid-session: 5 turns, 4 reused of 5 functions, tests passing.
const PONYTAIL = {
  level: 'full',
  spent: 1.5,
  turns: 5,
  turnCosts: [0.2, 0.25],
  tokens: { input: 1000, output: 2000, cacheRead: 300000, cacheWrite: 7000 },
  busyMs: 125_000,
  reused: ['a', 'b', 'c', 'd'],
  created: ['e'],
  openCallers: [],
  tests: { state: 'pass', passed: 12 },
}

// Seeds Ponytail's state: Ponytail installed and running in this session.
const withPonytail = (on: On) =>
  on('state.get', { plugin: 'ponytail' }, () => ({ value: { value: PONYTAIL, version: 1 } }) as never)

test('ponytail gets its own section, drawn like its details band, without graphify', async ($, on) => {
  world(on, { installed: false, graph: false })
  withPonytail(on)
  const ran: string[] = []
  on('command.run', (_, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const key of ['pt-level-off', 'pt-level-lite', 'pt-level-full', 'pt-level-ultra', 'pt-copy', 'pt-review', 'pt-audit', 'pt-board']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  for (const key of ['pt-details', 'pt-level', 'pt-col-callers']) expect(await ui.find({ key })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'PONYTAIL' })).toBeDefined()
  // The current level is marked in its label; the others are plain.
  expect(((await ui.find({ key: 'pt-level-full' })) as { props?: { label?: string } } | undefined)?.props?.label).toBe('✓ Full')
  expect(((await ui.find({ key: 'pt-level-lite' })) as { props?: { label?: string } } | undefined)?.props?.label).toBe('Lite')
  for (const text of ['$1.50', 'last $0.25 · ⌀ $0.30', '310.0k', '5 turns', '2m 5s', '80%', '12 passed']) {
    expect((await ui.find({ type: 'Text', text }))?.text).toBe(text)
  }
  expect(await ui.find({ key: 'install' })).toBeUndefined() // Ponytail alone counts as a tool on the bar
  await ui.press({ key: 'pt-level-lite' })
  await ui.press({ key: 'pt-review' })
  expect(ran).toEqual(['ponytail:ponytail lite', 'ponytail:ponytail-review'])
  await ui.unmount()

  // Desktop draws the columns as one SVG, as Ponytail does.
  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()
})

test('the settings pick which ponytail columns show', async ($, on) => {
  world(on, { installed: false, graph: false, settings: { stats: { ponytail: { cost: false, tests: false } } } })
  withPonytail(on)
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  for (const key of ['pt-col-cost', 'pt-col-tests']) expect(await ui.find({ key })).toBeUndefined()
  for (const key of ['pt-col-tokens', 'pt-col-time', 'pt-col-reuse']) expect(await ui.find({ key })).toBeDefined()
  await ui.unmount()
})

test('ponytail switched off the bar shows no section', async ($, on) => {
  world(on, { installed: false, graph: false, settings: { enabled: { ponytail: false } } })
  withPonytail(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'pt-copy' })).toBeUndefined()
  expect(await ui.find({ key: 'install' })).toBeDefined()
  await ui.unmount()
})

// grep's answer for ~/.claude/agents: three engineering agents, one lone "zk" agent (grouped as "other").
const AGENTS = [
  '/home/u/.claude/agents/engineering-frontend-developer.md:name: Frontend Developer',
  '/home/u/.claude/agents/engineering-backend-architect.md:name: Backend Architect',
  '/home/u/.claude/agents/engineering-code-reviewer.md:name: "Code Reviewer"',
  '/home/u/.claude/agents/zk-steward.md:name: ZK Steward',
].join('\n')

test('the agency section picks a division and an agent, and Use fills the prompt', async ($, on) => {
  world(on, { installed: false, graph: false, agents: AGENTS })
  const filled: string[] = []
  // The project already has its own Code Reviewer: a copy must never overwrite it.
  const written = new Map<string, string>([[`${CWD}/.claude/agents/engineering-code-reviewer.md`, 'my edits']])
  on('fs.exists', (_, e) => ({ value: written.has(e.path) }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined } as never
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'install' })).toBeUndefined() // agents alone count as a tool on the bar
    await ui.press({ key: 'agency-use' })
    await ui.select({ key: 'agency-group', value: 'other' })
    await ui.press({ key: 'agency-use' })
    await ui.select({ key: 'agency-group', value: 'engineering' })
    await ui.select({ key: 'agency-agent', value: 'Frontend Developer' })
    await ui.press({ key: 'agency-use' })
    await ui.press({ key: 'agency-auto' })
    expect(await ui.find({ type: 'Text', text: '→' })).toBeDefined()
    await ui.unmount()
  }
  // Only Use copies, once per agent; the project's own file is left alone.
  expect(Object.fromEntries(written)).toEqual({
    [`${CWD}/.claude/agents/engineering-code-reviewer.md`]: 'my edits',
    [`${CWD}/.claude/agents/engineering-backend-architect.md`]: 'agent engineering-backend-architect.md',
    [`${CWD}/.claude/agents/zk-steward.md`]: 'agent zk-steward.md',
    [`${CWD}/.claude/agents/engineering-frontend-developer.md`]: 'agent engineering-frontend-developer.md',
  })
  // Sorted by division then name: Backend Architect comes first in engineering.
  expect(filled.slice(0, 3)).toEqual([
    'Use the Backend Architect agent to ',
    'Use the ZK Steward agent to ',
    'Use the Frontend Developer agent to ',
  ])
  expect(filled[3]).toBe('Use the most suitable agent to ')
})

test('after an Auto prompt, the agent Claude calls is picked in the dropdowns and copied in', async ($, on) => {
  world(on, { installed: false, graph: false, agents: AGENTS })
  const written: string[] = []
  on('fs.exists', () => ({ value: false }))
  on('fs.write', (_, e) => {
    written.push(e.path)
    return { value: undefined } as never
  })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })

  // An ordinary prompt: Claude's agent call changes nothing.
  await $.prompt.submit({ text: 'tidy the README' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'ZK Steward', prompt: 'x', description: 'x' } as never)
  expect(written).toEqual([])

  // An Auto prompt: the first agency agent called is picked and copied, once.
  await $.prompt.submit({ text: 'Use the most suitable agent to tidy the README' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', prompt: 'x', description: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'ZK Steward', prompt: 'x', description: 'x' } as never)
  await $.tool.call({ tool: 'Agent', subagent_type: 'Backend Architect', prompt: 'x', description: 'x' } as never)
  expect(written).toEqual([`${CWD}/.claude/agents/zk-steward.md`])
  expect(((await ui.find({ key: 'agency-agent' })) as { props?: { value?: string } } | undefined)?.props?.value).toBe('ZK Steward')
  await ui.unmount()
})

// A Select over 64 options makes the engine refuse the whole band (the toolbar vanished once Auto picked an
// engineering agent: 66 of them). Big divisions are split into parts of up to 64.
test('a division of over 64 agents is split, so the band still draws with any pick', async ($, on) => {
  const many = Array.from({ length: 66 }, (_, i) => `/home/u/.claude/agents/engineering-a${String(i).padStart(2, '0')}.md:name: Eng ${String(i).padStart(2, '0')}`)
  world(on, { installed: false, graph: false, agents: many.join('\n') })
  on('state.get', { plugin: 'penguin', key: 'agentPick' }, () => ({ value: { value: { group: 'engineering 2', agent: 'Eng 65' }, version: 1 } }) as never)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const group = (await ui.find({ key: 'agency-group' })) as { props?: { options?: { value: string }[] } } | undefined
  expect(group?.props?.options?.map(o => o.value)).toEqual(['engineering 1', 'engineering 2'])
  const agent = (await ui.find({ key: 'agency-agent' })) as { props?: { options?: unknown[]; value?: string } } | undefined
  expect(agent?.props?.options?.length).toBe(2)
  expect(agent?.props?.value).toBe('Eng 65')
  await ui.unmount()
})

test('agency switched off the bar, or no agents, shows no section', async ($, on) => {
  world(on, { installed: false, graph: false, agents: AGENTS, settings: { enabled: { agency: false } } })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'agency-use' })).toBeUndefined()
  await ui.unmount()
})

test('desktop draws the logo file before the name; the terminal keeps the emoji', async ($, on) => {
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>'
  world(on, { installed: true, graph: false, logo: LOGO })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const desk = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(((await desk.find({ type: 'Svg' })) as { props?: { source?: string } } | undefined)?.props?.source).toBe(LOGO)
  expect((await desk.find({ type: 'Text', text: /PENGUIN/ }))?.text).toBe('PENGUIN')
  await desk.unmount()

  const term = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await term.find({ type: 'Svg' })).toBeUndefined()
  expect((await term.find({ type: 'Text', text: /PENGUIN/ }))?.text).toBe('🐧 PENGUIN')
  await term.unmount()
})

test('the band yields to a survey', async ($, on) => {
  world(on, { installed: true, graph: false })
  // Stands for the engine's own drawing, which a yielding hook hands the band to.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /PENGUIN/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /survey/ })).toBeDefined()
  await ui.unmount()
})
