import { applyMove, newGame } from '../game/engine'
import type { Color, GameState } from '../game/types'
import type { Agent } from './agent'

/** Deterministic PRNG (mulberry32) — same construction as tests/ai.test.ts. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface GameOutcome {
  /** 'A' or 'B' identifies the agent by argument position, not by color. */
  winner: 'A' | 'B' | null
  plies: number
  reason: 'loop' | 'line' | 'resignation' | 'ply-limit'
}

export interface PlayGameOptions {
  /** Games that run this long without a result are scored a draw. */
  plyLimit: number
  rand: () => number
}

/**
 * Play one game: `a` moves first (White), `b` second (Red). Mirrors the
 * full-game loop in tests/ai.test.ts's 'beats a random player' case, but as
 * reusable, agent-agnostic infrastructure.
 */
export function playGame(a: Agent, b: Agent, opts: PlayGameOptions): GameOutcome {
  let state: GameState = newGame()
  const seatOf: Record<Color, Agent> = { W: a, R: b }
  for (let ply = 0; ply < opts.plyLimit && !state.result; ply++) {
    const agent = seatOf[state.turn]
    const move = agent.move(state, opts.rand)
    const out = applyMove(state, move)
    if (!out.ok) throw new Error(`agent "${agent.name}" produced an illegal move: ${out.reason}`)
    state = out.state
  }
  if (!state.result) return { winner: null, plies: opts.plyLimit, reason: 'ply-limit' }
  const winner: 'A' | 'B' = seatOf[state.result.winner] === a ? 'A' : 'B'
  return { winner, plies: state.history.length, reason: state.result.reason }
}

export interface PlayMatchOptions {
  games: number
  /** Draw a game that runs this long without a decision. Default 300. */
  plyLimit?: number
  /** Seeds a per-match PRNG that in turn seeds each game; default 1. */
  seed?: number
}

export interface PlayGamesOptions extends PlayMatchOptions {
  /** First global game index to play. Default 0. */
  start?: number
  /** How many games to play from `start`. Default: the rest of the match. */
  count?: number
  /** Called after each game, with its global index. */
  onGame?: (index: number, outcome: GameOutcome) => void
}

/**
 * Counts from a set of games, mergeable across shards. Everything a
 * MatchReport needs is derivable from these — a 3-valued score has an exact
 * variance given the counts — so shards can be summed instead of shipping
 * per-game results around.
 */
export interface MatchTally {
  games: number
  aWins: number
  bWins: number
  draws: number
  totalPlies: number
}

export interface MatchReport {
  a: string
  b: string
  games: number
  aWins: number
  bWins: number
  draws: number
  /** a's score over all games (win=1, draw=0.5, loss=0); NaN if games is 0. */
  scoreForA: number
  /**
   * 95% Wald confidence interval on scoreForA. A quick, dependency-free
   * significance signal — good enough to tell "clearly stronger" from
   * "run more games", though SPRT or an Elo estimate would be more rigorous.
   */
  confidenceInterval: [number, number]
  /** True when the 95% CI excludes 0.5 (a is provably not equal strength). */
  significant: boolean
  avgPlies: number
}

const Z95 = 1.959963985

/**
 * The per-game seeds of a match, derived up front rather than inside the game
 * loop so any contiguous slice of a match can be replayed on its own: game `g`
 * gets `gameSeeds(seed, games)[g]` no matter how the games are split up.
 */
export function gameSeeds(seed: number, games: number): number[] {
  const matchRand = mulberry32(seed)
  return Array.from({ length: games }, () => Math.floor(matchRand() * 0xffffffff))
}

/**
 * Play global game indices `[start, start + count)` of a `games`-game match.
 * Both the seed and the color assignment key off the global index, so a shard
 * plays exactly the games it would have played inside the full sequential run.
 */
export function playGames(a: Agent, b: Agent, opts: PlayGamesOptions): MatchTally {
  const plyLimit = opts.plyLimit ?? 300
  const seeds = gameSeeds(opts.seed ?? 1, opts.games)
  const start = opts.start ?? 0
  const end = start + (opts.count ?? opts.games - start)

  const tally: MatchTally = { games: 0, aWins: 0, bWins: 0, draws: 0, totalPlies: 0 }
  for (let g = start; g < end; g++) {
    const rand = mulberry32(seeds[g])
    const swap = g % 2 === 1
    const outcome = swap ? flip(playGame(b, a, { plyLimit, rand })) : playGame(a, b, { plyLimit, rand })

    tally.games++
    tally.totalPlies += outcome.plies
    if (outcome.winner === null) tally.draws++
    else if (outcome.winner === 'A') tally.aWins++
    else tally.bWins++
    opts.onGame?.(g, outcome)
  }
  return tally
}

/** Sum shard tallies into the tally of the whole match. */
export function mergeTallies(tallies: MatchTally[]): MatchTally {
  return tallies.reduce(
    (acc, t) => ({
      games: acc.games + t.games,
      aWins: acc.aWins + t.aWins,
      bWins: acc.bWins + t.bWins,
      draws: acc.draws + t.draws,
      totalPlies: acc.totalPlies + t.totalPlies,
    }),
    { games: 0, aWins: 0, bWins: 0, draws: 0, totalPlies: 0 },
  )
}

/** Turn counts into the reported score, confidence interval, and averages. */
export function summarize(aName: string, bName: string, tally: MatchTally): MatchReport {
  const { games: n, aWins, bWins, draws } = tally
  const mean = (aWins + 0.5 * draws) / n
  // Population variance of a score that is only ever 1, 0.5, or 0.
  const variance = (aWins * (1 - mean) ** 2 + draws * (0.5 - mean) ** 2 + bWins * mean ** 2) / n
  const stderr = Math.sqrt(variance / n)
  const margin = Z95 * stderr
  const confidenceInterval: [number, number] = [Math.max(0, mean - margin), Math.min(1, mean + margin)]

  return {
    a: aName,
    b: bName,
    games: n,
    aWins,
    bWins,
    draws,
    scoreForA: mean,
    confidenceInterval,
    significant: confidenceInterval[0] > 0.5 || confidenceInterval[1] < 0.5,
    avgPlies: tally.totalPlies / n,
  }
}

/**
 * Play a full match of `games` games between two agents, swapping who plays
 * White every other game so first-move advantage cancels out of the result.
 * Deterministic for a given seed: same seed + same agents => identical report.
 */
export function playMatch(a: Agent, b: Agent, opts: PlayMatchOptions): MatchReport {
  if (opts.games < 1) throw new Error('playMatch requires at least one game')
  return summarize(a.name, b.name, playGames(a, b, { ...opts, start: 0, count: opts.games }))
}

/** Relabel an outcome from a (b, a)-seated game back to the (a, b) frame. */
function flip(outcome: GameOutcome): GameOutcome {
  return { ...outcome, winner: outcome.winner === null ? null : outcome.winner === 'A' ? 'B' : 'A' }
}
