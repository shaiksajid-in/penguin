// Pure helpers for PENGUIN's Ponytail section: no `$`. They mirror Ponytail's own band (its hooks/band/metrics.ts)
// so the section looks like its details view; `show` is PENGUIN's per-stat choice from the settings page (absent = shown).

import type { PonytailBand } from '../types'

export const LEVELS = ['off', 'lite', 'full', 'ultra']
export const EMPTY: PonytailBand = {
  level: 'off',
  spent: 0,
  turns: 0,
  turnCosts: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  busyMs: 0,
  reused: [],
  created: [],
  openCallers: [],
  tests: { state: 'none' },
}

type Show = Record<string, boolean>
const on = (show: Show, key: string) => show[key] !== false

export const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

export function elapsed(ms: number) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

const total = (b: PonytailBand) => b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheWrite

// Same threshold as Ponytail: below 3 functions one new helper would read as "0% reuse".
export const reuse = (b: PonytailBand) => {
  const n = b.reused.length + b.created.length
  return n < 3 ? undefined : Math.round((b.reused.length / n) * 100)
}

export const last = (b: PonytailBand) => b.turnCosts[b.turnCosts.length - 1]

export const testsLabel = (t: PonytailBand['tests']) =>
  t.state === 'pass' ? `${t.passed ?? ''} passed`.trim() : t.state === 'fail' ? `${t.failed ?? ''} failed`.trim() : t.state === 'stale' ? 'stale' : 'not run'

export type Col = { key: string; label: string; value: string; sub: string; tone?: 'warning' | 'success' | 'error' }

// The details view's columns, as Ponytail's details band draws them; callers and tests once there is something to report.
export function detailCols(b: PonytailBand, show: Show): Col[] {
  const l = last(b)
  const avg = b.turns > 0 ? b.spent / b.turns : 0
  const r = reuse(b)
  const t = b.tests
  const cols: (Col | false)[] = [
    on(show, 'cost') && {
      key: 'cost',
      label: 'cost',
      value: `$${b.spent.toFixed(2)}`,
      sub: l === undefined || !on(show, 'last') ? '' : `last $${l.toFixed(2)} · ⌀ $${avg.toFixed(2)}`,
    },
    on(show, 'tokens') && {
      key: 'tokens',
      label: 'tokens',
      value: fmtTokens(total(b)),
      sub: on(show, 'turns') ? `${b.turns} ${b.turns === 1 ? 'turn' : 'turns'}` : '',
    },
    on(show, 'time') && {
      key: 'time',
      label: 'agent time',
      value: elapsed(b.busyMs),
      sub: b.turns > 0 ? `⌀ ${elapsed(b.busyMs / b.turns)} / turn` : '',
    },
    on(show, 'reuse') && r !== undefined && { key: 'reuse', label: 'reuse', value: `${r}%`, sub: '' },
    on(show, 'callers') && b.openCallers.length > 0 && {
      key: 'callers',
      label: 'callers',
      value: `${b.openCallers.length} open`,
      sub: b.openCallers.slice(0, 2).join(', '),
      tone: 'warning',
    },
    on(show, 'tests') && t.state !== 'none' && {
      key: 'tests',
      label: 'tests',
      value: testsLabel(t),
      sub: t.state === 'pass' ? 'after last change' : t.state === 'fail' ? 'last run' : 'code changed since',
      tone: t.state === 'pass' ? 'success' : t.state === 'fail' ? 'error' : undefined,
    },
  ]
  return cols.filter((c): c is Col => c !== false)
}

// What Copy puts on the clipboard: the columns shown, as a Markdown table.
const cell = (v: string) => v.replace(/\|/g, '\\|')
export const markdown = (b: PonytailBand, cols: Col[]) =>
  ['## Ponytail', '', '| | |', '|---|---|', `| level | ${cell(b.level)} |`, ...cols.map(c => `| ${cell(c.label)} | ${cell(c.value + (c.sub ? ` (${c.sub})` : ''))} |`)].join('\n')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fit = (s: string, max: number) => (s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s)

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
// shortcut: follows the system theme, not the app's (same as Ponytail); pass the theme in if they differ.
const STYLE = `.l,.s{fill:#87867f;font:12px ${FONT}}.v{fill:#1f1e1d;font:600 16px ${FONT}}.d{stroke:#1f1e1d;stroke-opacity:.12}.b{fill:#87867f}.warning{fill:#a86400}.success{fill:#2e7d32}.error{fill:#c62828}@media (prefers-color-scheme:dark){.v{fill:#ecebe6}.d{stroke:#fff;stroke-opacity:.14}.warning{fill:#e3a03d}.success{fill:#6abf69}.error{fill:#ef6a5a}}`

// Ponytail's desktop details row: one SVG with real 1px dividers, exact columns and the per-turn cost bars.
export function metricsSvg(cols: Col[], turnCosts: number[], width = 720): string {
  // Shorter than Ponytail's own 64px strip, and no top rule, so the whole band fits above the prompt without scrolling.
  const height = 54
  const colW = width / Math.max(1, cols.length)
  const max = Math.max(...turnCosts, 0)
  let body = ''
  cols.forEach((c, i) => {
    const x = i * colW + (i === 0 ? 0 : 12)
    const tone = c.tone ? ` ${c.tone}` : ''
    if (i > 0) body += `<line class="d" x1="${i * colW}" y1="4" x2="${i * colW}" y2="${height - 2}"/>`
    body += `<text class="l" x="${x}" y="14">${esc(c.label)}</text>`
    body += `<text class="v${tone}" x="${x}" y="33">${esc(fit(c.value, Math.floor((colW - 16) / 9)))}</text>`
    if (c.sub) body += `<text class="s${c.tone === 'warning' ? tone : ''}" x="${x}" y="49">${esc(fit(c.sub, Math.floor((colW - 16) / 6.2)))}</text>`
    if (c.key === 'cost' && turnCosts.length > 1 && max > 0) {
      const bars = turnCosts.slice(-10)
      const x0 = (i + 1) * colW - 16 - bars.length * 5
      bars.forEach((v, j) => {
        const h = Math.max(1, Math.round((v / max) * 14))
        body += `<rect class="b" x="${x0 + j * 5}" y="${33 - h}" width="3" height="${h}" rx="1"/>`
      })
    }
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${STYLE}</style>${body}</svg>`
}
