#!/usr/bin/env -S npx tsx
/**
 * Search benchmark over a frozen set of real positions.
 *
 * The arena and vs-analyst answer "is this stronger"; this answers "is this
 * faster, and how much does a ply cost" — the two mechanism numbers that decide
 * whether a change is worth a 4000-game gate at all. Both are measured on a
 * committed fixture (`scripts/bench-positions.json`) rather than on freshly
 * played games, so a number from today is comparable with one from six months
 * ago even after the analyst dependency moves.
 *
 * Usage:
 *   npm run bench -- [--agents A,B] [--budget MS | --nodes N]
 *   npm run bench -- --depths 3,4,5,6 [--agents A,B]
 *   npm run bench -- --from losses.json [--out FILE] [--count 38] [--ply 20]
 *
 * Modes:
 *   default    node rate at a time/node budget, plus nodes and depth per move.
 *   --depths   nodes required to *complete* each depth, with the clock lifted
 *              and the node cap off, and the effective branching factor between
 *              them (the geometric mean over the range, which is the number to
 *              quote — alpha-beta's odd/even oscillation makes any single ratio
 *              misleading).
 *   --from     regenerate the fixture from a `vs-analyst --diag --out` dump.
 *
 * **The trap this exists to avoid.** `chooseMove` reports the last *fully
 * completed* iteration, and since partial-iteration retention landed it keeps
 * work from an aborted deeper one. So the depth histogram understates what the
 * search actually looked at, and reading a branching factor off mean-depth at a
 * node cap gives roughly 27 where the truth is under 7. Measure nodes-to-
 * complete-depth-`d` directly, at a fixed `maxDepth` with the clock lifted, which
 * is what `--depths` does.
 *
 * **Two things a number from here is not.** The transposition table is
 * module-level and deliberately persists across `chooseMove` calls, so every row
 * of a `--depths` table runs warmer than the one above it, and depth 5 measured
 * alone is *not* the depth 5 of a `3,4,5` run (~570k vs ~470k here). That is the
 * same condition the shipped search runs in, so it is not a bug to fix — but it
 * means only rows within one invocation, and arms within one row, are
 * comparable. And the fixture is a specific 38 positions: absolute node counts
 * do not carry across regenerations of it, only ratios do.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mulberry32 } from '../src/ai/arena'
import { chooseMove as chooseV1, type SearchLimits, type SearchResult } from '../src/ai/search'
import { chooseMove as chooseCurrent } from '../src/ai/search2'
import { chooseMove as chooseBase } from '../src/ai/search2base'
import { replayTranscript } from '../src/game/transcript'
import type { GameState } from '../src/game/types'

type ChooseFn = (state: GameState, limits: SearchLimits) => SearchResult | null

/** Same registry shape as scripts/arena.ts and scripts/vs-analyst.ts. */
const CHOOSERS: Record<string, ChooseFn> = {
  current: chooseCurrent,
  base: chooseBase,
  v1: chooseV1,
}

const FIXTURE = fileURLToPath(new URL('./bench-positions.json', import.meta.url))

interface Fixture {
  /** How the fixture was made, so it can be regenerated the same way. */
  source: string
  /** Plies replayed from each transcript before the position is taken. */
  ply: number
  transcripts: string[]
}

// --- CLI ----------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      opts[name] = 'true'
      continue
    }
    opts[name] = next
    i++
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

// --- Fixture generation (--from) ----------------------------------------------

/**
 * Build the fixture from a `vs-analyst --diag --out` dump. Positions come from
 * games we actually lost because that is where the tactical motifs are dense —
 * the same corpus choice the eval's precision studies made — and every
 * transcript is truncated to the same ply so the set has a uniform game phase.
 */
if (opts.from) {
  const ply = Number(opts.ply ?? 20)
  const count = Number(opts.count ?? 38)
  const out = opts.out ?? FIXTURE
  const dump = JSON.parse(readFileSync(opts.from, 'utf8')) as { losses: Array<{ transcript: string }> }

  const transcripts: string[] = []
  const seen = new Set<string>()
  for (const loss of dump.losses) {
    const tokens = loss.transcript.trim().split(/\s+/).filter(Boolean)
    if (tokens.length <= ply) continue // too short to reach the sample ply
    const prefix = tokens.slice(0, ply).join(' ')
    if (seen.has(prefix)) continue // distinct positions only
    const replay = replayTranscript(prefix)
    if (!replay.ok || replay.line[replay.line.length - 1].result) continue
    seen.add(prefix)
    transcripts.push(prefix)
    if (transcripts.length === count) break
  }
  if (transcripts.length < count) {
    throw new Error(`only ${transcripts.length} usable positions in ${opts.from}, wanted ${count}`)
  }

  const fixture: Fixture = { source: `${opts.from} (vs-analyst --diag --out), first ${count} distinct`, ply, transcripts }
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`)
  console.log(`${transcripts.length} positions at ply ${ply} → ${out}`)
  process.exit(0)
}

// --- Positions ----------------------------------------------------------------

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
const positions: GameState[] = fixture.transcripts.map((t) => {
  const replay = replayTranscript(t)
  if (!replay.ok) throw new Error(`bad fixture transcript: ${replay.error}`)
  return replay.line[replay.line.length - 1]
})

const agentNames = (opts.agents ?? 'current').split(',').map((s) => s.trim())
for (const n of agentNames) {
  if (!CHOOSERS[n]) throw new Error(`unknown agent "${n}"; have: ${Object.keys(CHOOSERS).join(', ')}`)
}

/**
 * Fixed rand and `topMargin: 0` make every run of a given agent identical: the
 * root's variety pool is the only nondeterminism in `chooseMove`, and a
 * benchmark wants the same line searched every time.
 */
const seededLimits = (extra: Partial<SearchLimits>): SearchLimits => ({
  budgetMs: 1000,
  maxDepth: 16,
  topMargin: 0,
  rand: mulberry32(1),
  ...extra,
})

const fmt = (n: number): string => n.toLocaleString('en-US')

// --- --depths: nodes to complete each depth -----------------------------------

if (opts.depths || opts.depth) {
  const depths = (opts.depths ?? opts.depth).split(',').map((s) => Number(s.trim()))
  console.log(`${agentNames.join(' + ')} — nodes to complete each depth over ${positions.length} positions`)
  console.log('(clock lifted, no node cap, topMargin 0)')

  for (const name of agentNames) {
    const choose = CHOOSERS[name]
    console.log('')
    console.log(`  ${name}`)
    console.log('    depth        nodes   x prev   completed')
    let prev = 0
    const ratios: number[] = []
    for (const d of depths) {
      let nodes = 0
      let completed = 0
      for (const state of positions) {
        // budgetMs Infinity makes the deadline Infinity, so only maxDepth binds.
        const r = choose(state, seededLimits({ budgetMs: Infinity, maxDepth: d }))
        if (!r) continue
        nodes += r.nodes
        // A position the search decides outright stops early, so it never
        // "completes" depth d; counting it would understate the cost of a ply.
        if (r.depth >= d) completed++
      }
      const ratio = prev > 0 ? nodes / prev : 0
      if (ratio > 0) ratios.push(ratio)
      console.log(
        `    ${String(d).padEnd(5)} ${fmt(nodes).padStart(12)}   ${(ratio > 0 ? ratio.toFixed(1) : '—').padStart(6)}   ${completed}/${positions.length}`,
      )
      prev = nodes
    }
    if (ratios.length > 0) {
      const ebf = Math.exp(ratios.reduce((a, b) => a + Math.log(b), 0) / ratios.length)
      console.log(`    effective branching factor (geometric mean): ${ebf.toFixed(1)}`)
    }
  }
  process.exit(0)
}

// --- default: node rate -------------------------------------------------------

const limits = seededLimits(
  opts.nodes
    ? { maxNodes: Number(opts.nodes), budgetMs: opts.budget ? Number(opts.budget) : Infinity }
    : { budgetMs: Number(opts.budget ?? 1000) },
)
const cap = opts.nodes ? `${fmt(Number(opts.nodes))} nodes${opts.budget ? ` / ${opts.budget}ms` : ''}` : `${limits.budgetMs}ms`

console.log(`${agentNames.join(' + ')} — ${positions.length} positions @ ${cap}`)

/**
 * Arms are interleaved position by position rather than run as separate passes,
 * so a thermal or scheduling drift over the run hits both equally — the same
 * reason vs-analyst plays both arms of a paired match inside one process.
 */
const totals = new Map(agentNames.map((n) => [n, { nodes: 0, ms: 0, depth: 0, moves: 0 }]))
for (const state of positions) {
  for (const name of agentNames) {
    const started = performance.now()
    const r = CHOOSERS[name](state, limits)
    const elapsed = performance.now() - started
    if (!r) continue
    const t = totals.get(name)!
    t.nodes += r.nodes
    t.ms += elapsed
    t.depth += r.depth
    t.moves++
  }
}

for (const name of agentNames) {
  const t = totals.get(name)!
  console.log('')
  console.log(`  ${name}`)
  console.log(`    ${(t.nodes / (t.ms / 1000) / 1000).toFixed(1)}k nodes/s over ${fmt(t.nodes)} nodes in ${(t.ms / 1000).toFixed(1)}s`)
  console.log(`    ${fmt(Math.round(t.nodes / t.moves))} nodes/move, ${(t.ms / t.moves).toFixed(0)}ms/move, mean completed depth ${(t.depth / t.moves).toFixed(2)}`)
}
