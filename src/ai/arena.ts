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
 * Play a full match of `games` games between two agents, swapping who plays
 * White every other game so first-move advantage cancels out of the result.
 * Deterministic for a given seed: same seed + same agents => identical report.
 */
export function playMatch(a: Agent, b: Agent, opts: PlayMatchOptions): MatchReport {
  if (opts.games < 1) throw new Error('playMatch requires at least one game')
  const plyLimit = opts.plyLimit ?? 300
  const matchRand = mulberry32(opts.seed ?? 1)

  let aWins = 0
  let bWins = 0
  let draws = 0
  let totalPlies = 0
  const scores: number[] = []

  for (let g = 0; g < opts.games; g++) {
    const gameSeed = Math.floor(matchRand() * 0xffffffff)
    const rand = mulberry32(gameSeed)
    const swap = g % 2 === 1
    const outcome = swap ? flip(playGame(b, a, { plyLimit, rand })) : playGame(a, b, { plyLimit, rand })
    totalPlies += outcome.plies

    if (outcome.winner === null) {
      draws++
      scores.push(0.5)
    } else if (outcome.winner === 'A') {
      aWins++
      scores.push(1)
    } else {
      bWins++
      scores.push(0)
    }
  }

  const n = opts.games
  const mean = scores.reduce((s, x) => s + x, 0) / n
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  const stderr = Math.sqrt(variance / n)
  const margin = Z95 * stderr
  const confidenceInterval: [number, number] = [Math.max(0, mean - margin), Math.min(1, mean + margin)]

  return {
    a: a.name,
    b: b.name,
    games: n,
    aWins,
    bWins,
    draws,
    scoreForA: mean,
    confidenceInterval,
    significant: confidenceInterval[0] > 0.5 || confidenceInterval[1] < 0.5,
    avgPlies: totalPlies / n,
  }
}

/** Relabel an outcome from a (b, a)-seated game back to the (a, b) frame. */
function flip(outcome: GameOutcome): GameOutcome {
  return { ...outcome, winner: outcome.winner === null ? null : outcome.winner === 'A' ? 'B' : 'A' }
}
