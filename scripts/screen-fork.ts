#!/usr/bin/env -S npx tsx
/**
 * Screen candidate **fork predicates** against ground truth.
 *
 * `scratch/ai-next-steps.md` item 1: the predicate that works — a threat whose
 * two closing cells are ≥3 apart — is 94.3% precise at only 35.7% recall, and
 * the 64% it misses is the whole remaining prize. This is the method that found
 * that number (and that killed the "two distinct closing cells" proposal before
 * it cost a gate): precision and recall against the exact 2-ply answer, over
 * every position of every game we lost.
 *
 * Usage:
 *   npx tsx scripts/screen-fork.ts --from dump.json [--key losses] [--games N]
 *
 * `--from` takes a `vs-analyst --out` dump. Ground truth per position is the
 * same test `vs-analyst.ts:diagnose()` applies: the side to move is **forked**
 * when every legal move either loses outright or leaves the opponent a win in
 * one. That is computed exactly, by playing both plies on a FastBoard — a
 * predicate is only worth its runtime cost if it agrees with this.
 *
 * A candidate has to clear *both* screens before it is worth a gate: precision
 * and recall here, and Δ val-loss as a group in `scripts/train-eval.ts`. And
 * then <5% nps on **both** bench fixtures, since the last threat predicate cost
 * 18% of the node rate and gated level.
 */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { waiterThreats } from '../src/ai/features'
import { cellX, cellY, DELTA, FastBoard, ILLEGAL, OK } from '../src/ai/fastboard'
import { replayTranscript } from '../src/game/transcript'

interface Opts {
  from: string
  key: string
  games: number
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = { from: '', key: 'losses', games: Infinity }
  for (let i = 0; i < argv.length; i++) {
    const v = (): string => {
      const val = argv[++i]
      if (val === undefined) throw new Error(`missing value for ${argv[i - 1]}`)
      return val
    }
    switch (argv[i]) {
      case '--from': o.from = v(); break
      case '--key': o.key = v(); break
      case '--games': o.games = Number(v()); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  if (!o.from) throw new Error('--from FILE is required (a vs-analyst --out dump)')
  return o
}

// --- Ground truth -------------------------------------------------------------

const outer: number[] = []
const inner: number[] = []

/** Does the side to move have a move that ends the game in its favour at once? */
function hasWinInOne(fb: FastBoard): boolean {
  const mover = fb.turn
  const n = fb.moves(inner)
  for (let i = 0; i < n; i++) {
    const mv = inner[i]
    const status = fb.make(mv >>> 3, mv & 7)
    if (status === ILLEGAL) continue
    fb.unmake()
    if (status - 1 === mover) return true
  }
  return false
}

/**
 * The side to move is forked: every legal move either loses outright or hands
 * the opponent a win in one. Mirrors `vs-analyst.ts:diagnose()` exactly,
 * including that losing outright does **not** count as safe, but computed over
 * make/unmake rather than immutable states — 76×76 plies per position is far too
 * much for the engine.
 */
function forked(fb: FastBoard): boolean {
  const mover = fb.turn
  const n = fb.moves(outer)
  // `moves` writes into the buffer it is given and `hasWinInOne` needs its own,
  // so the outer list is snapshotted before any nesting happens.
  const moves = outer.slice(0, n)
  for (const mv of moves) {
    const status = fb.make(mv >>> 3, mv & 7)
    if (status === ILLEGAL) continue
    if (status !== OK) {
      const won = status - 1 === mover
      fb.unmake()
      if (won) return false // a move that wins on the spot is the safest there is
      continue
    }
    const lost = hasWinInOne(fb)
    fb.unmake()
    if (!lost) return false
  }
  return true
}

// --- Candidate predicates -----------------------------------------------------

const manhattan = (a: number, b: number): number =>
  Math.abs(cellX(a) - cellX(b)) + Math.abs(cellY(a) - cellY(b))

const maxSeparation = (cells: readonly number[]): number => {
  let best = 0
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = manhattan(cells[i], cells[j])
      if (d > best) best = d
    }
  }
  return best
}

/**
 * Is there a single cell from which one placement could answer *every* closing
 * cell in `cells`?
 *
 * A placement answers a closing cell by occupying it or by fixing an edge on a
 * cell beside it, so its reach is Manhattan distance 1. The pairwise-separation
 * test is the two-cell special case of this; over three or more cells they come
 * apart, because three cells can be pairwise within 2 with no common answerer.
 * That is the generalisation this predicate exists to test.
 */
function hasCommonAnswer(cells: readonly number[]): boolean {
  const candidates = new Set<number>()
  for (const c of cells) {
    candidates.add(c)
    for (let d = 0; d < 4; d++) candidates.add(c + DELTA[d])
  }
  for (const c of candidates) {
    let all = true
    for (const cell of cells) {
      if (manhattan(c, cell) > 1) {
        all = false
        break
      }
    }
    if (all) return true
  }
  return false
}

interface Predicate {
  name: string
  /** `threats` is one array of closing cells per verified threat of the waiter. */
  test: (threats: readonly number[][]) => boolean
}

const union = (threats: readonly number[][]): number[] => {
  const seen = new Set<number>()
  for (const t of threats) for (const c of t) seen.add(c)
  return [...seen]
}

const PREDICATES: Predicate[] = [
  // The two the 2026-07-29 study measured, as controls: whatever a new candidate
  // does, it has to be read against these.
  { name: 'any closing cell', test: (t) => t.length > 0 },
  { name: 'one track, cells >= 3 apart', test: (t) => t.some((c) => maxSeparation(c) >= 3) },
  // New: the same idea across *all* of the waiter's threats rather than within
  // one. Two tracks each closable one step away is a fork the within-track test
  // cannot see, and forks across tracks are exactly what `loopDouble` counts.
  { name: 'union of tracks, cells >= 3 apart', test: (t) => maxSeparation(union(t)) >= 3 },
  { name: '>= 2 threatening tracks', test: (t) => t.length >= 2 },
  // New: the dominating-cell generalisation. Strictly stronger than a pairwise
  // distance test, and the cheap enumeration the next-steps document asks for.
  { name: 'union has no common answer', test: (t) => union(t).length >= 2 && !hasCommonAnswer(union(t)) },
  { name: 'one track has no common answer', test: (t) => t.some((c) => c.length >= 2 && !hasCommonAnswer(c)) },
]

// --- Screen -------------------------------------------------------------------

const o = parseOpts(process.argv.slice(2))
const dump = JSON.parse(readFileSync(o.from, 'utf8')) as Record<string, Array<{ transcript: string }>>
const games = dump[o.key]
if (!Array.isArray(games)) throw new Error(`${o.from} has no game list under "${o.key}"`)

const fires = new Array<number>(PREDICATES.length).fill(0)
const hits = new Array<number>(PREDICATES.length).fill(0)
let positions = 0
let forks = 0
const threats: number[][] = []
/**
 * How many verified threats the waiter holds, among forked positions and among
 * all of them. This is the number that says whether a *fork* predicate is the
 * right tool at all: a forked position with only one verified threat is not a
 * two-threat detection problem, however precise the detector.
 */
const threatHistFork = new Array<number>(6).fill(0)
const threatHistAll = new Array<number>(6).fill(0)

const started = performance.now()
for (const game of games.slice(0, o.games)) {
  const replay = replayTranscript(game.transcript)
  if (!replay.ok) throw new Error(`bad transcript: ${replay.error}`)
  for (const state of replay.line) {
    if (state.result) continue
    // A fresh board per position: `forked` plays two plies deep and the
    // predicates play one, and a shared board would have to be provably clean.
    const fb = FastBoard.fromState(state)
    const isFork = forked(fb)
    positions++
    if (isFork) forks++
    waiterThreats(fb, threats)
    const bucket = Math.min(threats.length, threatHistAll.length - 1)
    threatHistAll[bucket]++
    if (isFork) threatHistFork[bucket]++
    for (let p = 0; p < PREDICATES.length; p++) {
      if (!PREDICATES[p].test(threats)) continue
      fires[p]++
      if (isFork) hits[p]++
    }
  }
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`
console.log(
  `${positions} positions from ${Math.min(games.length, o.games)} ${o.key} games in ${o.from}` +
    ` (${((performance.now() - started) / 1000).toFixed(0)}s)`,
)
console.log(`ground truth: ${forks} forked (${pct(forks / positions)}) — the mover has no safe move`)
console.log('')
console.log('predicate                              fires   precision   recall')
for (let p = 0; p < PREDICATES.length; p++) {
  console.log(
    `${PREDICATES[p].name.padEnd(38)} ${String(fires[p]).padStart(5)}   ` +
      `${(fires[p] > 0 ? pct(hits[p] / fires[p]) : '—').padStart(9)}   ${pct(hits[p] / forks).padStart(6)}`,
  )
}

console.log('')
console.log("verified threats the waiter holds, and how often that position is forked:")
console.log('threats   positions   forked   share of all forks')
for (let k = 0; k < threatHistAll.length; k++) {
  if (threatHistAll[k] === 0) continue
  const label = k === threatHistAll.length - 1 ? `${k}+` : String(k)
  console.log(
    `${label.padEnd(9)} ${String(threatHistAll[k]).padStart(9)}   ${String(threatHistFork[k]).padStart(6)}   ` +
      `${pct(threatHistFork[k] / forks).padStart(8)}`,
  )
}
