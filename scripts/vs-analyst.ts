#!/usr/bin/env -S npx tsx
/**
 * Benchmark our search against `@slugbugblue/trax-analyst` — a fixed, external
 * opponent, which is where AI changes here actually show up. Self-play (see
 * scripts/arena.ts) cancels symmetric tactical gains and has repeatedly read
 * "level" for changes worth several points against the analyst.
 *
 * Usage:
 *   npm run vs-analyst -- [--agent NAME | --agents A,B] [--games N] [--seed N |
 *                          --seeds 1,2,3] [--ply N] [--budget MS] [--nodes N]
 *                          [--margin N] [--jobs N] [--analyst pick|best]
 *                          [--diag] [--sprt [--sprt-delta F]] [--out FILE]
 *
 * Shape mirrors scripts/arena.ts: the parent splits the game indices into
 * contiguous ranges, each range is played by a child `tsx` process running this
 * script in shard mode, and the parent merges the shards' counts. Search modules
 * keep module-level state (transposition table, eval caches, scratch buffers),
 * so shards are processes rather than threads.
 *
 * Beyond win rate this reports the two things the arena cannot:
 *
 *   - **nps / depth**, from the `SearchResult` every move already returns, so a
 *     speed win is never mistaken for a strength win (and vice versa);
 *   - **`--diag`**, a taxonomy of *why* we lost: the first ply at which every one
 *     of our legal moves handed the analyst a win-in-1, and how many winning
 *     replies it had there. `forkWidth == 1` is a single unstoppable threat (more
 *     search depth); `>= 2` is a fork (an eval/threat-detection problem).
 *
 * `--out` dumps the transcripts, losses and a sample of won/drawn games under
 * separate keys — the raw material for both bench fixtures (`scripts/bench.ts
 * --from --key`) and for the eval's precision studies.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Trax } from '@slugbugblue/trax'
import { suggest } from '@slugbugblue/trax-analyst'
import type { Agent } from '../src/ai/agent'
import { gameSeeds, mulberry32 } from '../src/ai/arena'
import { chooseMove as chooseV1, type SearchLimits, type SearchResult } from '../src/ai/search'
import { AI_LIMITS, chooseMove as chooseCurrent } from '../src/ai/search2'
import { chooseMove as chooseBase } from '../src/ai/search2base'
import { chooseMove as chooseFit } from '../src/ai/search2fit'
import { chooseMove as choosePre } from '../src/ai/search2pre'
import { applyMove, newGame } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import { decodeMove } from '../src/game/notation'
import { encodeMoves, replayTranscript } from '../src/game/transcript'
import type { Color, GameState, Move } from '../src/game/types'

const SCRIPT = fileURLToPath(import.meta.url)
const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

type ChooseFn = (state: GameState, limits: SearchLimits) => SearchResult | null

/**
 * Our agents, by name — the analyst-side mirror of scripts/arena.ts's
 * `buildRegistry`. A variant module under test gets registered here, exactly as
 * it would there, and `--agents current,variant` then plays both over identical
 * game seeds.
 */
const CHOOSERS: Record<string, ChooseFn> = {
  current: chooseCurrent,
  // Frozen copy of the shipped search + board as of commit 14da60e, so a change
  // can be gated paired against exactly what it replaced. See src/ai/search2base.ts.
  base: chooseBase,
  // Frozen copy of the search as of commit ad67e68, before the 2026-07-30
  // evaluation-pricing round. `base` is four promoted rounds stale, so it is not
  // a valid pairing arm for that round — this is. See src/ai/search2pre.ts.
  pre: choosePre,
  // The shipped search with an outcome-fitted evaluation; see src/ai/search2fit.ts.
  fit: chooseFit,
  v1: chooseV1,
}

// --- The analyst, bridged onto our engine -------------------------------------

/** Our Color for the side Trax says is to move ('w' = White, 'b' = Red). */
function traxTurn(trax: Trax): Color {
  return trax.color === 'w' ? 'W' : 'R'
}

/**
 * Assert our position and the analyst's agree. The '/' vs '\' mapping in
 * notation.ts was wrong until commit 9a84b19, so a silently divergent bridge is
 * a demonstrated failure mode here: any mismatch aborts the run rather than
 * quietly scoring a game that was never the game we thought we were playing.
 */
function checkBridge(trax: Trax, state: GameState, ply: number): void {
  const theirs = Object.keys(trax.tiles).length
  const ours = state.board.size
  if (theirs !== ours) {
    throw new Error(
      `bridge divergence at ply ${ply}: ${ours} tiles here, ${theirs} in Trax — "${encodeMoves(state.history)}"`,
    )
  }
  if (traxTurn(trax) !== state.turn) {
    throw new Error(`bridge divergence at ply ${ply}: ${state.turn} to move here, ${trax.color} in Trax`)
  }
}

interface AnalystAgent extends Agent {
  /** Random stream the analyst draws its pick from; reset per game. */
  rand: () => number
}

/**
 * The analyst as an Agent. It is a *1-ply* engine that draws at random among
 * every move within 5 points of best, so `suggest().pick` — not `.all[0]` — is
 * the opponent it is designed to be; `--analyst best` selects the deterministic
 * strict-best variant only so older measurements stay reproducible.
 */
function analystAgent(mode: string): AnalystAgent {
  const self: AnalystAgent = {
    name: 'analyst',
    rand: Math.random,
    move(state: GameState): Move {
      const notation = encodeMoves(state.history)
      const trax = notation ? new Trax('trax', notation) : new Trax('trax')
      checkBridge(trax, state, state.history.length)

      // `Suggestion` picks via randomDraw over the within-5-points pool, reading
      // the global Math.random at call time; swap it for our seeded stream.
      const saved = Math.random
      Math.random = self.rand
      let picked: string
      try {
        const s = suggest(trax)
        picked = mode === 'best' ? s.all[0].move : s.pick.move
      } finally {
        Math.random = saved
      }

      const move = decodeMove(state.board, picked)
      if (!move) throw new Error(`analyst pick "${picked}" did not decode at ply ${state.history.length}`)
      return move
    },
  }
  return self
}

// --- Our side, instrumented ---------------------------------------------------

/** Per-agent search instrumentation, summed over every move of every game. */
interface Instrument {
  nodes: number
  searchMs: number
  searchCalls: number
  depthSum: number
  /** depthHist[d] = moves whose deepest *completed* iteration was d. */
  depthHist: number[]
}

const MAX_HIST_DEPTH = 33

function newInstrument(): Instrument {
  return { nodes: 0, searchMs: 0, searchCalls: 0, depthSum: 0, depthHist: new Array<number>(MAX_HIST_DEPTH).fill(0) }
}

/**
 * `searchAgent` from src/ai/agent.ts, but keeping the SearchResult's `nodes`
 * and `depth` instead of dropping them — node rate is what converts into depth
 * and therefore into strength at a time budget, so it is worth measuring in the
 * same run as the score.
 */
function ourAgent(name: string, choose: ChooseFn, limits: SearchLimits, instr: Instrument): Agent {
  return {
    name,
    move(state, rand) {
      const started = performance.now()
      const r = choose(state, { ...limits, rand })
      instr.searchMs += performance.now() - started
      if (!r) throw new Error(`agent "${name}" returned no move for a non-terminal state`)
      instr.searchCalls++
      instr.nodes += r.nodes
      instr.depthSum += r.depth
      instr.depthHist[Math.min(r.depth, MAX_HIST_DEPTH - 1)]++
      return r.move
    },
  }
}

// --- Match --------------------------------------------------------------------

interface Loss {
  seed: number
  agent: string
  /** Global game index within its seed, so a loss can be replayed on its own. */
  game: number
  /** Our color in this game: W = we moved first, R = second. */
  color: Color
  /** How the analyst won. */
  reason: string
  plies: number
  transcript: string
  /** --diag: first ply where every legal move of ours gave a win-in-1; -1 if never. */
  forkPly?: number
  /** --diag: fewest winning replies the analyst had there, over our best try. */
  forkWidth?: number
}

/**
 * A won or drawn game, kept for `--out` so the dump can seed a bench fixture
 * that is *not* drawn from losses. Only every `--out-sample`th game is kept: at
 * a 96% win rate these outnumber the losses ~25:1, and a fixture needs a few
 * dozen positions, not thousands.
 *
 * Sample generously, though: distinct *positions* are what a fixture needs, and
 * the analyst's first plies repeat heavily — 109 sampled games gave only 28
 * distinct positions at ply 20.
 */
interface NonLoss {
  seed: number
  agent: string
  game: number
  color: Color
  /** 'win' or 'draw'; a loss goes in `losses` instead, with its taxonomy. */
  result: 'win' | 'draw'
  plies: number
  transcript: string
}


/** Everything a report needs from one agent's games, mergeable across shards. */
interface AgentTally {
  games: number
  wins: number
  draws: number
  losses: number
  totalPlies: number
  instr: Instrument
  lossList: Loss[]
  /** Sampled won/drawn games; only populated under `--out`. */
  nonLossList: NonLoss[]
}

function newTally(): AgentTally {
  return { games: 0, wins: 0, draws: 0, losses: 0, totalPlies: 0, instr: newInstrument(), lossList: [], nonLossList: [] }
}

/**
 * Paired per-game score differences between arm A and arm B, bucketed by
 * `(scoreA - scoreB) * 2 + 2` — the difference of two 3-valued scores only ever
 * takes the five values -1, -0.5, 0, 0.5, 1, so the histogram carries the exact
 * mean and variance and still merges by addition.
 */
type PairHist = number[]

interface ShardResult {
  byAgent: Record<string, AgentTally>
  pairHist: PairHist
}

/**
 * Sequential probability ratio test on the paired difference, so a gate stops as
 * soon as it is decided instead of always playing the full match. The budgeted
 * gates run over an hour at 2000 games and usually settle long before the end.
 *
 * `pairHist` already carries everything this needs: the difference of two
 * 3-valued scores takes only five values, so the histogram gives the exact mean
 * and variance of the paired difference and merges by addition.
 *
 * H0 is "no difference", H1 is "A is `delta` better" (default +2pt, about the
 * smallest effect the promotion log has ever cared about). The statistic is the
 * usual normal-approximation GSPRT log-likelihood ratio for a mean shift,
 * `n·δ·(x̄ − δ/2)/σ̂²`, against Wald's bounds at α = β = 0.05. Using the observed
 * variance rather than a modelled one is what makes it valid for a *paired*
 * difference, whose variance is far below that of either arm alone — that
 * variance reduction is precisely why pairing is worth doing.
 */
const SPRT_ALPHA = 0.05
const SPRT_BETA = 0.05
const SPRT_LOWER = Math.log(SPRT_BETA / (1 - SPRT_ALPHA))
const SPRT_UPPER = Math.log((1 - SPRT_BETA) / SPRT_ALPHA)
/**
 * Pairs required before the test may fire at all. The statistic divides by an
 * *estimated* variance, and paired differences are mostly zero early on — a
 * handful of identical pairs gives a sample variance of 0 and an LLR of
 * ±infinity, which decided a match after 9 games in testing. A floor on n is the
 * honest fix: the variance estimate has to be worth dividing by.
 */
const SPRT_MIN_PAIRS = 50

interface SprtState {
  n: number
  mean: number
  llr: number
  decision: 'H1' | 'H0' | null
}

function sprt(hist: PairHist, delta: number): SprtState {
  let n = 0
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < 5; i++) {
    const d = (i - 2) / 2
    n += hist[i]
    sum += d * hist[i]
    sumSq += d * d * hist[i]
  }
  if (n === 0) return { n, mean: 0, llr: 0, decision: null }
  const mean = sum / n
  const variance = sumSq / n - mean ** 2
  if (n < SPRT_MIN_PAIRS || !(variance > 0)) return { n, mean, llr: 0, decision: null }
  const llr = (n * delta * (mean - delta / 2)) / variance
  return { n, mean, llr, decision: llr >= SPRT_UPPER ? 'H1' : llr <= SPRT_LOWER ? 'H0' : null }
}

function mergeInto(acc: ShardResult, s: ShardResult): void {
  for (const [name, t] of Object.entries(s.byAgent)) {
    const a = (acc.byAgent[name] ??= newTally())
    a.games += t.games
    a.wins += t.wins
    a.draws += t.draws
    a.losses += t.losses
    a.totalPlies += t.totalPlies
    a.instr.nodes += t.instr.nodes
    a.instr.searchMs += t.instr.searchMs
    a.instr.searchCalls += t.instr.searchCalls
    a.instr.depthSum += t.instr.depthSum
    for (let d = 0; d < MAX_HIST_DEPTH; d++) a.instr.depthHist[d] += t.instr.depthHist[d] ?? 0
    a.lossList.push(...t.lossList)
    a.nonLossList.push(...(t.nonLossList ?? []))
  }
  for (let i = 0; i < 5; i++) acc.pairHist[i] += s.pairHist[i] ?? 0
}

// --- Loss taxonomy (--diag) ---------------------------------------------------

/** Legal moves for the side to move that end the game in their favor at once. */
function winningReplies(state: GameState): number {
  if (state.result) return 0
  const mover = state.turn
  let n = 0
  for (const m of legalMoves(state)) {
    const out = applyMove(state, m)
    if (out.ok && out.state.result?.winner === mover) n++
  }
  return n
}

/**
 * Classify one loss: find the first ply we were to move at where *every* legal
 * move either lost outright or left the opponent a win-in-1, and record how many
 * winning replies it had there after our best try.
 *
 * `forkWidth == 1` means a single unstoppable threat — a position we should not
 * have entered, which is a search-depth problem. `>= 2` means a genuine fork,
 * which one more ply cannot fix and which needs threat detection instead. Which
 * bucket dominates is the number this harness exists to track.
 */
function diagnose(loss: Loss): void {
  const replay = replayTranscript(loss.transcript)
  if (!replay.ok) throw new Error(`game ${loss.game}: ${replay.error}`)
  loss.forkPly = -1
  loss.forkWidth = 0
  for (let i = 0; i < replay.line.length - 1; i++) {
    const state = replay.line[i]
    if (state.turn !== loss.color || state.result) continue
    let safe = 0
    let minWidth = Infinity
    for (const m of legalMoves(state)) {
      const out = applyMove(state, m)
      if (!out.ok) continue
      if (out.state.result) {
        if (out.state.result.winner === loss.color) {
          safe++
          minWidth = 0
        }
        continue
      }
      const w = winningReplies(out.state)
      if (w === 0) safe++
      if (w < minWidth) minWidth = w
    }
    if (safe === 0) {
      loss.forkPly = i
      loss.forkWidth = minWidth === Infinity ? 0 : minWidth
      return
    }
  }
}

// --- CLI ----------------------------------------------------------------------

interface Args {
  opts: Record<string, string>
  flags: Set<string>
}

/** Like scripts/arena.ts's parseArgs, plus valueless flags (`--diag`). */
const VALUELESS = new Set(['diag', 'sprt'])

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string> = {}
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`)
    const name = arg.slice(2)
    if (VALUELESS.has(name)) {
      flags.add(name)
      continue
    }
    const value = argv[++i]
    if (value === undefined) throw new Error(`missing value for ${arg}`)
    opts[name] = value
  }
  return { opts, flags }
}

/** Drop `--name value` from an argv, so it can be replaced or omitted. */
function stripOpt(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      i++ // also skip its value
      continue
    }
    out.push(argv[i])
  }
  return out
}

/**
 * Job count. Unlike the arena there is no `auto`: against a *fixed* opponent the
 * job count changes how many games share a transposition table and moves the
 * score by ~3pt (docs/ai-arena.md), so it has to be pinned and recorded rather
 * than derived from whatever machine is running.
 */
function parseJobs(value: string | undefined, total: number): number {
  if (value === 'auto') {
    throw new Error('--jobs auto is not allowed here: against a fixed opponent the score moves ~3pt with the job count, so pin it (see docs/ai-arena.md)')
  }
  const requested = value ? Number(value) : 1
  if (!Number.isFinite(requested) || requested < 1) throw new Error(`invalid --jobs value: ${value}`)
  return Math.max(1, Math.min(Math.floor(requested), total))
}

/** Split `[0, total)` into `jobs` contiguous ranges of game indices. */
function splitRanges(total: number, jobs: number): Array<{ start: number; count: number }> {
  const base = Math.floor(total / jobs)
  const remainder = total % jobs
  const ranges: Array<{ start: number; count: number }> = []
  let start = 0
  for (let i = 0; i < jobs; i++) {
    const count = base + (i < remainder ? 1 : 0)
    if (count === 0) continue
    ranges.push({ start, count })
    start += count
  }
  return ranges
}

/** Progress on stderr — stdout stays the parseable report. Throttled to ~1/s. */
function makeProgress(total: number): (done: number) => void {
  let lastAt = 0
  return (done) => {
    const now = performance.now()
    if (done < total && now - lastAt < 1000) return
    lastAt = now
    const line = `  ${done}/${total} games`
    process.stderr.write(process.stderr.isTTY ? `\r${line}${done >= total ? '\n' : ''}` : `${line}\n`)
  }
}

const argv = process.argv.slice(2)
const { opts, flags } = parseArgs(argv)

const games = Number(opts.games ?? 100)
const plyLimit = Number(opts.ply ?? 300)
const seeds = (opts.seeds ?? opts.seed ?? '1').split(',').map(Number)
const agentNames = (opts.agents ?? opts.agent ?? 'current').split(',')
const analystMode = opts.analyst ?? 'pick'
const wantDiag = flags.has('diag')
const wantSprt = flags.has('sprt')
/** H1's effect size, as a fraction of a point of score. Default +2pt. */
const sprtDelta = Number(opts['sprt-delta'] ?? 0.02)
/** Keep one won/drawn game in this many for `--out`; see NonLoss. */
const nonLossSample = Number(opts['out-sample'] ?? 25)

if (!Number.isFinite(games) || games < 1) throw new Error('--games must be at least 1')
if (seeds.some((s) => !Number.isFinite(s))) throw new Error(`bad --seeds: ${opts.seeds ?? opts.seed}`)
if (analystMode !== 'pick' && analystMode !== 'best') throw new Error('--analyst must be pick|best')
if (agentNames.length > 2) throw new Error('--agents takes at most two names')
// The test is defined on the paired difference, which needs both arms.
if (wantSprt && agentNames.length !== 2) throw new Error('--sprt needs --agents A,B: the test runs on the paired difference')
if (wantSprt && (!Number.isFinite(sprtDelta) || sprtDelta <= 0)) throw new Error(`bad --sprt-delta: ${opts['sprt-delta']}`)
for (const n of agentNames) {
  if (!CHOOSERS[n]) throw new Error(`unknown agent "${n}"; have: ${Object.keys(CHOOSERS).join(', ')}`)
}

const limits: SearchLimits = { ...AI_LIMITS }
if (opts.nodes) limits.maxNodes = Number(opts.nodes)
if (opts.budget) limits.budgetMs = Number(opts.budget)
else if (opts.nodes) {
  // `--nodes` exists to compare strength at equal *work*, but the shipped
  // budgetMs is 1500 and this search runs ~10k nodes/s, so a 20000-node cap is
  // only reached about half the time — the rest of the moves are cut by the
  // clock. That silently hands a faster build more nodes than the baseline,
  // which is exactly the confound a node cap is supposed to remove. So a bare
  // `--nodes` run lifts the budget out of the way; pass `--budget` alongside it
  // to reproduce a historical number measured under the shipped one.
  limits.budgetMs = 3_600_000
}
// topMargin is the app's move-variety pool (AI_LIMITS.topMargin): the root picks
// at random among moves within this of best. --margin 0 makes us deterministic.
if (opts.margin) limits.topMargin = Number(opts.margin)

/** Salt keeping the analyst's stream independent of the one our agent uses. */
const ANALYST_SALT = 0x5bf03635

/**
 * Play global game indices [start, start+count) for every seed and every agent.
 * Both arms of an `--agents A,B` run play the same game index back to back
 * inside the same shard, so they see identical seeds, identical analyst streams
 * and identical machine load — the per-game differences pair exactly.
 */
function playRange(start: number, count: number, onGame?: (r: ShardResult) => void, stopping?: () => boolean): ShardResult {
  const analyst = analystAgent(analystMode)
  const result: ShardResult = { byAgent: {}, pairHist: [0, 0, 0, 0, 0] }
  const arms = agentNames.map((name) => {
    const tally = newTally()
    result.byAgent[name] = tally
    return { name, agent: ourAgent(name, CHOOSERS[name], limits, tally.instr), tally }
  })

  for (const seed of seeds) {
    const perGameSeeds = gameSeeds(seed, games)
    for (let g = start; g < start + count; g++) {
      // Under --sprt the parent may decide the match mid-run. Stopping between
      // games rather than mid-game keeps every tally consistent and every arm's
      // game count equal, so a partial shard merges exactly like a full one.
      if (stopping?.()) return finish(result)
      // Even indices we move first, odd we move second — the same alternation
      // the arena uses, so first-move advantage cancels over the match.
      const ourColor: Color = g % 2 === 0 ? 'W' : 'R'
      const scores: number[] = []

      for (const arm of arms) {
        const rand = mulberry32(perGameSeeds[g])
        analyst.rand = mulberry32((perGameSeeds[g] ^ ANALYST_SALT) >>> 0)
        const seat: Record<Color, Agent> =
          ourColor === 'W' ? { W: arm.agent, R: analyst } : { W: analyst, R: arm.agent }

        let state = newGame()
        for (let ply = 0; ply < plyLimit && !state.result; ply++) {
          const agent = seat[state.turn]
          // Every ply is bridge-checked, including our own: the analyst only
          // sees the positions it moves in, so a divergence introduced on our
          // move would otherwise surface a ply late — or not at all, if the
          // game ended first.
          if (agent !== analyst) {
            const notation = encodeMoves(state.history)
            checkBridge(notation ? new Trax('trax', notation) : new Trax('trax'), state, ply)
          }
          const out = applyMove(state, agent.move(state, rand))
          if (!out.ok) throw new Error(`agent "${agent.name}" played an illegal move: ${out.reason}`)
          state = out.state
        }

        arm.tally.games++
        arm.tally.totalPlies += state.history.length
        if (!state.result) {
          arm.tally.draws++
          scores.push(0.5)
          keepNonLoss(arm, seed, g, ourColor, 'draw', state)
        } else if (state.result.winner === ourColor) {
          arm.tally.wins++
          scores.push(1)
          keepNonLoss(arm, seed, g, ourColor, 'win', state)
        } else {
          arm.tally.losses++
          scores.push(0)
          arm.tally.lossList.push({
            seed,
            agent: arm.name,
            game: g,
            color: ourColor,
            reason: state.result.reason,
            plies: state.history.length,
            transcript: encodeMoves(state.history),
          })
        }
        onGame?.(result)
      }

      if (scores.length === 2) result.pairHist[(scores[0] - scores[1]) * 2 + 2]++
    }
  }

  return finish(result)

  function finish(r: ShardResult): ShardResult {
    if (wantDiag) for (const arm of arms) for (const l of arm.tally.lossList) diagnose(l)
    return r
  }

  /**
   * Record a won or drawn game for `--out`, one game in `--out-sample`.
   * Keyed on the global game index so the sample is the same set however the
   * match is sharded, exactly like the per-game seeds.
   */
  function keepNonLoss(
    arm: { name: string; tally: AgentTally },
    seed: number,
    g: number,
    color: Color,
    outcome: 'win' | 'draw',
    state: GameState,
  ): void {
    if (!opts.out || g % nonLossSample !== 0) return
    arm.tally.nonLossList.push({
      seed,
      agent: arm.name,
      game: g,
      color,
      result: outcome,
      plies: state.history.length,
      transcript: encodeMoves(state.history),
    })
  }
}

// --- Shard mode: play our slice, hand the counts back on stdout ---------------

if (opts['shard-start'] !== undefined) {
  const start = Number(opts['shard-start'])
  const count = Number(opts['shard-count'])
  if (!Number.isFinite(start) || !Number.isFinite(count)) throw new Error('bad --shard-start/--shard-count')
  let done = 0
  // The parent decides when a --sprt match is over, but it cannot tell us over
  // IPC: playRange is one long synchronous loop, so the child's event loop never
  // runs and a `message` would not be delivered until the shard had already
  // finished. So the signal is a file the parent creates, checked with a stat
  // between game pairs — microseconds against games that take about a second.
  const stopFile = opts['stop-file']
  const shard = playRange(
    start,
    count,
    (r) => process.send?.({ done: ++done, pairHist: wantSprt ? r.pairHist : undefined }),
    stopFile ? () => existsSync(stopFile) : undefined,
  )
  console.log(JSON.stringify(shard))
  process.disconnect?.()
} else {
  const jobs = parseJobs(opts.jobs, games)
  const ranges = splitRanges(games, jobs)
  const totalGames = games * seeds.length * agentNames.length
  const cap = opts.nodes
    ? `${limits.maxNodes} nodes${opts.budget ? ` / ${limits.budgetMs}ms` : ''}`
    : `${limits.budgetMs}ms`

  console.log(
    `${agentNames.join(' + ')} vs analyst[${analystMode}] — ${games} games x ${seeds.length} seed(s) ` +
      `@ ${cap}, margin ${limits.topMargin}, ${jobs} jobs`,
  )

  const started = performance.now()
  const merged: ShardResult = { byAgent: {}, pairHist: [0, 0, 0, 0, 0] }

  /** Set once the SPRT has decided, so the report can say the match stopped early. */
  let stopped: SprtState | null = null
  /**
   * How the decision reaches the shards. Its *existence* is the signal, so it is
   * created only on a crossing; the directory is unique per run so a crash never
   * leaves a file that would cut a later match short.
   */
  const stopDir = wantSprt ? mkdtempSync(join(tmpdir(), 'vs-analyst-sprt-')) : null
  const stopFile = stopDir ? join(stopDir, 'stop') : null

  if (jobs === 1) {
    const report = makeProgress(totalGames)
    let done = 0
    mergeInto(
      merged,
      playRange(
        0,
        games,
        (r) => {
          report(++done)
          if (!wantSprt || stopped) return
          const s = sprt(r.pairHist, sprtDelta)
          if (s.decision) stopped = s
        },
        () => stopped !== null,
      ),
    )
  } else {
    const report = makeProgress(totalGames)
    const perShard = new Map<number, number>()
    const perShardHist = new Map<number, PairHist>()
    const childArgv = stripOpt(argv, 'jobs')
    const children: Array<ReturnType<typeof spawn>> = []
    const stopArgs = wantSprt ? ['--stop-file', stopFile!] : []
    const shards = ranges.map(
      (range, i) =>
        new Promise<ShardResult>((resolve, reject) => {
          const label = `shard [${range.start}, ${range.start + range.count})`
          const child = spawn(
            TSX_BIN,
            [SCRIPT, ...childArgv, ...stopArgs, '--shard-start', String(range.start), '--shard-count', String(range.count)],
            { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] },
          )
          children.push(child)
          let out = ''
          child.stdout?.on('data', (chunk) => (out += chunk))
          child.on('message', (msg) => {
            const { done, pairHist } = msg as { done?: unknown; pairHist?: PairHist }
            if (typeof done !== 'number') return
            perShard.set(i, done)
            let total = 0
            for (const n of perShard.values()) total += n
            report(total)

            if (!wantSprt || stopped) return
            if (pairHist) perShardHist.set(i, pairHist)
            // Every shard's latest snapshot, summed. Shards report at different
            // rates, so this is a running total over whatever pairs are complete
            // anywhere — see the note in the report below about what that costs.
            const running: PairHist = [0, 0, 0, 0, 0]
            for (const h of perShardHist.values()) for (let k = 0; k < 5; k++) running[k] += h[k]
            const s = sprt(running, sprtDelta)
            if (!s.decision) return
            stopped = s
            writeFileSync(stopFile!, `${s.decision}\n`)
          })
          child.on('error', reject)
          child.on('exit', (code, signal) => {
            if (code !== 0) {
              return reject(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
            }
            const line = out.trim().split('\n').at(-1)
            let parsed: ShardResult | undefined
            try {
              parsed = line ? (JSON.parse(line) as ShardResult) : undefined
            } catch {
              parsed = undefined
            }
            const expect = range.count * seeds.length
            const got = parsed && Object.values(parsed.byAgent)[0]?.games
            // A short shard is normally a silently truncated match, which is
            // exactly what this guard exists to prevent. It is legitimate only
            // when *we* asked the shard to stop, so the exemption is tied to
            // having sent the stop rather than to --sprt merely being on.
            const short = stopped !== null && got !== undefined && got < expect
            if (!parsed || (got !== expect && !short)) {
              return reject(new Error(`${label} reported ${got ?? 'no'} games, expected ${expect}`))
            }
            resolve(parsed)
          })
        }),
    )
    try {
      for (const s of await Promise.all(shards)) mergeInto(merged, s)
    } catch (err) {
      for (const c of children) c.kill()
      throw err
    } finally {
      if (stopDir) rmSync(stopDir, { recursive: true, force: true })
    }
  }

  const elapsedS = (performance.now() - started) / 1000
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`

  for (const name of agentNames) {
    const t = merged.byAgent[name]
    const score = (t.wins + 0.5 * t.draws) / t.games
    // Same 3-valued-score variance the arena's summarize() uses. Raw counts are
    // pooled across seeds before this runs, which is the pooling docs/ai-arena.md
    // asks for and is easy to get wrong by averaging per-seed percentages.
    const variance = (t.wins * (1 - score) ** 2 + t.draws * (0.5 - score) ** 2 + t.losses * score ** 2) / t.games
    const margin = 1.959963985 * Math.sqrt(variance / t.games)
    const i = t.instr

    console.log('')
    console.log(`  ${name}: ${t.wins}W ${t.losses}L ${t.draws}D over ${t.games} games`)
    console.log(`    score: ${pct(score)}  (95% CI ${pct(Math.max(0, score - margin))}–${pct(Math.min(1, score + margin))})`)
    console.log(
      `    search: ${(i.nodes / Math.max(i.searchMs / 1000, 1e-9) / 1000).toFixed(1)}k nodes/s, ` +
        `${Math.round(i.nodes / i.searchCalls)} nodes/move, ${(i.searchMs / i.searchCalls).toFixed(0)}ms/move, ` +
        `mean depth ${(i.depthSum / i.searchCalls).toFixed(2)}`,
    )
    const hist = i.depthHist.flatMap((n, d) => (n > 0 ? [`${d}:${n}`] : []))
    console.log(`    depth histogram: ${hist.join(' ')}`)
    console.log(`    avg game length: ${(t.totalPlies / t.games).toFixed(1)} plies`)

    const byReason: Record<string, number> = {}
    const byColor: Record<string, number> = { W: 0, R: 0 }
    for (const l of t.lossList) {
      byReason[l.reason] = (byReason[l.reason] ?? 0) + 1
      byColor[l.color]++
    }
    const wGames = Math.ceil(games / 2) * seeds.length
    console.log(`    losses by win-type: ${JSON.stringify(byReason)}`)
    console.log(`    losses by our color: W ${byColor.W}/${wGames}, R ${byColor.R}/${t.games - wGames}  (W = we moved first)`)

    if (wantDiag) {
      let unforked = 0
      const widths: Record<number, number> = {}
      for (const l of t.lossList) {
        if ((l.forkPly ?? -1) < 0) unforked++
        else widths[Math.min(l.forkWidth ?? 0, 5)] = (widths[Math.min(l.forkWidth ?? 0, 5)] ?? 0) + 1
      }
      const single = widths[1] ?? 0
      const forked = t.losses - unforked
      console.log(`    forced (no safe move at some ply): ${forked}/${t.losses}, never forced: ${unforked}`)
      console.log(`    forkWidth == 1 (single unstoppable threat — needs depth): ${single}`)
      console.log(`    forkWidth >= 2 (a fork — needs threat detection):        ${forked - single}`)
      console.log(`    forkWidth histogram (5+ bucketed): ${JSON.stringify(widths)}`)
    }
  }

  if (agentNames.length === 2) {
    const n = merged.pairHist.reduce((a, b) => a + b, 0)
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < 5; i++) {
      const d = (i - 2) / 2
      sum += d * merged.pairHist[i]
      sumSq += d * d * merged.pairHist[i]
    }
    const mean = sum / n
    const stderr = Math.sqrt(Math.max(0, sumSq / n - mean ** 2) / n)
    const lo = mean - 1.959963985 * stderr
    const hi = mean + 1.959963985 * stderr
    const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(2)}pt`
    console.log('')
    console.log(`  paired ${agentNames[0]} − ${agentNames[1]} over ${n} identical games: ${pp(mean)}  (95% CI ${pp(lo)} – ${pp(hi)})`)
    console.log(
      `  NOTE: both arms run in one process and hold separate module-level TTs, so each\n` +
        `  absolute score sits below a solo run. The pairing is unaffected — it is equal for both.`,
    )

    if (wantSprt) {
      // Recomputed over everything that finished, which is a few pairs more than
      // the running total that triggered the stop: shards complete the pair they
      // are in. It is the better statistic of the two, so it is the verdict.
      const final = sprt(merged.pairHist, sprtDelta)
      const verdict =
        final.decision === 'H1'
          ? `H1 accepted: ${agentNames[0]} is better by at least ${pp(sprtDelta)}`
          : final.decision === 'H0'
            ? `H0 accepted: no gain of ${pp(sprtDelta)} for ${agentNames[0]}`
            : `inconclusive — ${stopped ? 'the extra pairs pulled it back inside the bounds' : 'the game cap was reached first'}`
      console.log('')
      console.log(`  SPRT (H0 +0.00pt vs H1 ${pp(sprtDelta)}, alpha=beta=0.05): ${verdict}`)
      console.log(`    LLR ${final.llr.toFixed(2)} against bounds ${SPRT_LOWER.toFixed(2)} / ${SPRT_UPPER.toFixed(2)} after ${n} pairs`)
      if (stopped) {
        const at = stopped as SprtState
        console.log(`    stopped early at ${at.n} pairs (LLR ${at.llr.toFixed(2)}) of the ${games * seeds.length} requested`)
        console.log(
          `  NOTE: reproducible in its DECISION, not in its game count — with --jobs > 1 the\n` +
            `  pairs finished at the stop are not a prefix of the match, so a rerun stops\n` +
            `  somewhere else. Record --jobs beside the result as always.`,
        )
      }
    }
  }

  console.log('')
  console.log(`  ${elapsedS.toFixed(0)}s total`)

  if (opts.out) {
    const byGame = <T extends { seed: number; game: number }>(a: T, b: T): number => a.seed - b.seed || a.game - b.game
    const losses = agentNames.flatMap((n) => merged.byAgent[n].lossList).sort(byGame)
    // Won and drawn games go in their own key rather than alongside the losses:
    // every consumer so far wants one or the other, never the union. See
    // `scripts/bench.ts --from --key`, which builds a fixture from either.
    const nonLosses = agentNames.flatMap((n) => merged.byAgent[n].nonLossList).sort(byGame)
    writeFileSync(
      opts.out,
      JSON.stringify({ agents: agentNames, games, seeds, cap, sample: nonLossSample, losses, nonLosses }, null, 1),
    )
    console.log(`  ${losses.length} loss + ${nonLosses.length} sampled won/drawn transcripts → ${opts.out}`)
  }
}
