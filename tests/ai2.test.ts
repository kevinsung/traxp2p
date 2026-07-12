import { describe, expect, it } from 'vitest'
import { components, WIN_SCORE } from '../src/ai/eval'
import { chooseMove } from '../src/ai/search2'
import type { SearchLimits } from '../src/ai/search'
import { key } from '../src/game/board'
import { applyMove, newGame, otherColor } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import type { Board, Color, GameState, Move, TileKind } from '../src/game/types'

/**
 * v2 search behavior tests: mirrors tests/ai.test.ts's chooseMove suite
 * (mate-in-1, blocking, the straight-line-builder regression, beats-random)
 * against search2, plus a mate-in-N only visible to a deeper search.
 */

function play(state: GameState, moves: Move[]): GameState {
  for (const m of moves) {
    const out = applyMove(state, m)
    if (!out.ok) throw new Error(`move ${JSON.stringify(m)} rejected: ${out.reason}`)
    state = out.state
  }
  return state
}

function stateWith(tiles: Array<[number, number, TileKind]>, turn: Color = 'W'): GameState {
  const board: Board = new Map(tiles.map(([x, y, t]) => [key(x, y), t]))
  return { board, turn, history: [], result: null }
}

const m = (x: number, y: number, tile: TileKind): Move => ({ x, y, tile })

// Deterministic PRNG (mulberry32) for reproducible searches and playouts.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic limits for tests: huge time budget, capped nodes. */
const testLimits = (seed: number, extra?: Partial<SearchLimits>): SearchLimits => ({
  budgetMs: 60_000,
  maxDepth: 4,
  maxNodes: 50_000,
  rand: rng(seed),
  ...extra,
})

// White one move from a loop (same position as tests/ai.test.ts).
const nearLoop: Array<[number, number, TileKind]> = [
  [0, 0, 'RRWW'],
  [-1, 0, 'RWWR'],
]

describe('search2 chooseMove', () => {
  it('finds a mate in one', () => {
    const s = stateWith(nearLoop, 'W')
    const r = chooseMove(s, testLimits(1))!
    const out = applyMove(s, r.move)
    expect(out.ok && out.state.result?.winner).toBe('W')
  })

  it('blocks the opponent’s mate in one without completing it', () => {
    const s = stateWith(nearLoop, 'R')
    const r = chooseMove(s, testLimits(2))!
    const out = applyMove(s, r.move)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.state.result).toBeNull()
    for (const reply of legalMoves(out.state)) {
      const w = applyMove(out.state, reply)
      expect(w.ok && w.state.result?.winner === 'W').toBe(false)
    }
  })

  it('returns null when the game is over', () => {
    const won = play(newGame(), [m(0, 0, 'RRWW'), m(-1, 0, 'RWWR'), m(0, 1, 'WRRW')])
    expect(won.result).not.toBeNull()
    expect(chooseMove(won, testLimits(3))).toBeNull()
  })

  it('finds a forced win beyond mate-in-1 and converts it', { timeout: 120_000 }, () => {
    // Self-play position (found by search, verified by playout): White to
    // move has a forced win in 3 plies — invisible to a mate-in-1 scan.
    const prefix: Move[] = [
      m(0, 0, 'WRWR'), m(0, -1, 'RRWW'), m(-1, 0, 'RRWW'), m(0, 1, 'WWRR'),
      m(1, 0, 'WWRR'), m(2, 0, 'RRWW'), m(2, -1, 'WWRR'), m(3, 0, 'WWRR'),
      m(2, -2, 'WRWR'), m(2, -3, 'RRWW'), m(1, 1, 'RWRW'), m(2, 2, 'RWRW'),
      m(4, 2, 'RWWR'), m(3, 3, 'RWRW'), m(0, -2, 'RWRW'), m(-1, -2, 'WWRR'),
      m(5, 2, 'WRRW'), m(4, 0, 'RWRW'), m(5, 4, 'WWRR'), m(6, 1, 'WWRR'),
    ]
    let state = play(newGame(), prefix)
    expect(state.turn).toBe('W')

    const r = chooseMove(state, testLimits(4, { maxDepth: 5, maxNodes: 200_000, topMargin: 0 }))!
    expect(r.score).toBeGreaterThanOrEqual(WIN_SCORE - 100)

    // Convert: White follows the search; Red defends with the same search.
    for (let ply = 0; ply < 4 && !state.result; ply++) {
      const move = chooseMove(state, testLimits(10 + ply, { maxDepth: 5, maxNodes: 200_000, topMargin: 0 }))!.move
      state = play(state, [move])
    }
    expect(state.result?.winner).toBe('W')
  })

  it('beats a straight-line-building opponent', { timeout: 240_000 }, () => {
    // Same regression opponent as tests/ai.test.ts, but v2's node cap is set
    // to what its ~20x node rate affords within the app's 1.5s budget.
    const whiteSpan = (s: GameState): number =>
      Math.max(0, ...components(s.board).filter((c) => c.color === 'W').map((c) => Math.max(c.spanX, c.spanY)))

    const redWinsNext = (s: GameState): boolean =>
      legalMoves(s).some((mv) => {
        const r = applyMove(s, mv)
        return r.ok && r.state.result?.winner === 'R'
      })

    const lineBuilderMove = (s: GameState): Move => {
      const scored: { mv: Move; span: number; safe: boolean }[] = []
      for (const mv of legalMoves(s)) {
        const r = applyMove(s, mv)
        if (!r.ok) continue
        if (r.state.result) {
          if (r.state.result.winner === 'W') return mv
          continue
        }
        scored.push({ mv, span: whiteSpan(r.state), safe: !redWinsNext(r.state) })
      }
      const safe = scored.filter((x) => x.safe)
      const pool = safe.length > 0 ? safe : scored
      pool.sort((a, b) => b.span - a.span)
      return pool[0].mv
    }

    // ~20k nodes matches what the app's 1.5s budget affords v2 (depth 4-6).
    const limits = testLimits(5, { maxDepth: 16, maxNodes: 20_000, topMargin: 5 })
    let state = newGame()
    while (!state.result && state.history.length < 60) {
      const mv = state.turn === 'W' ? lineBuilderMove(state) : chooseMove(state, limits)!.move
      state = play(state, [mv])
    }
    // v1's bar was merely surviving 60 plies; v2's depth finds the sound
    // counter-threat refutations, so it must win outright.
    expect(state.result?.winner).toBe('R')
  })

  it('beats a random player', { timeout: 120_000 }, () => {
    let wins = 0
    let losses = 0
    for (let seed = 1; seed <= 4; seed++) {
      for (const aiColor of ['W', 'R'] as const) {
        const rand = rng(seed)
        const limits = testLimits(seed, { maxNodes: 20_000, maxDepth: 16 })
        let state = newGame()
        for (let ply = 0; ply < 80 && !state.result; ply++) {
          const move =
            state.turn === aiColor
              ? chooseMove(state, limits)!.move
              : (() => {
                  const moves = legalMoves(state)
                  return moves[Math.floor(rand() * moves.length)]
                })()
          state = play(state, [move])
        }
        if (state.result?.winner === aiColor) wins++
        else if (state.result?.winner === otherColor(aiColor)) losses++
      }
    }
    expect(losses).toBe(0)
    expect(wins).toBeGreaterThanOrEqual(6)
  })
})
