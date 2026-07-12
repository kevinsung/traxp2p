import { describe, expect, it } from 'vitest'
import { components, evaluate, WEIGHTS } from '../src/ai/eval'
import { chooseMove, positionHash, type SearchLimits } from '../src/ai/search'
import { key } from '../src/game/board'
import { applyMove, newGame, otherColor } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import { undoTo } from '../src/hooks/useAIGame'
import type { Board, Color, GameState, Move, TileKind } from '../src/game/types'

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
  maxDepth: 2,
  maxNodes: 50_000,
  rand: rng(seed),
  ...extra,
})

// White one move from a loop: its track through (0,0)-(-1,0) has both ends
// pointing south into adjacent cells (see the engine tests' loop scenario).
const nearLoop: Array<[number, number, TileKind]> = [
  [0, 0, 'RRWW'],
  [-1, 0, 'RWWR'],
]

describe('positionHash', () => {
  it('is independent of insertion order and sensitive to turn and tiles', () => {
    const a = stateWith(nearLoop)
    const b = stateWith([...nearLoop].reverse() as typeof nearLoop)
    expect(positionHash(a.board, 'W')).toBe(positionHash(b.board, 'W'))
    expect(positionHash(a.board, 'W')).not.toBe(positionHash(a.board, 'R'))
    const c = stateWith([
      [0, 0, 'RRWW'],
      [-1, 0, 'WWRR'],
    ])
    expect(positionHash(c.board, 'W')).not.toBe(positionHash(a.board, 'W'))
  })
})

describe('evaluate', () => {
  it('finds the tracks on the board', () => {
    const comps = components(stateWith(nearLoop).board)
    expect(comps).toHaveLength(3) // one white track through both tiles, two red curves
    const white = comps.filter((c) => c.color === 'W')
    expect(white).toHaveLength(1)
    expect(white[0].cells).toBe(2)
    expect(white[0].spanX).toBe(2)
    expect(new Set(white[0].exits!.map((e) => key(e.x, e.y)))).toEqual(new Set(['0,1', '-1,1']))
    expect(white[0].dirs).toEqual([2, 2]) // both ends leave southward
  })

  it('scores a converged loop threat strongly and antisymmetrically', () => {
    const s = stateWith(nearLoop)
    expect(evaluate(s, 'W')).toBeGreaterThan(0)
    expect(evaluate(s, 'R')).toBeLessThan(0)
    expect(evaluate(s, 'R')).toBe(-evaluate(s, 'W'))
  })

  it('scores a growing line higher as it lengthens', () => {
    const stack = (h: number) =>
      stateWith(Array.from({ length: h }, (_, y) => [0, y, 'WRWR'] as [number, number, TileKind]))
    let prev = evaluate(stack(2), 'W')
    for (let h = 3; h <= 7; h++) {
      const cur = evaluate(stack(h), 'W')
      expect(cur).toBeGreaterThan(prev)
      prev = cur
    }
  })

  it('scores a near-line open at both ends as practically decided, a capped one far less', () => {
    // Seven stacked crosses: white's column is one row short of LINE_SPAN and
    // can complete at either end — the opponent cannot block both.
    const open = stateWith(Array.from({ length: 7 }, (_, y) => [0, y, 'WRWR'] as [number, number, TileKind]))
    expect(evaluate(open, 'W')).toBeGreaterThan(WEIGHTS.lineDouble / 2)
    expect(evaluate(open, 'R')).toBe(-evaluate(open, 'W'))
    // The same column capped at the bottom (track turned east) no longer
    // threatens a vertical line, even though its cell span is larger.
    const capped = stateWith([
      ...Array.from({ length: 7 }, (_, y) => [0, y, 'WRWR'] as [number, number, TileKind]),
      [0, 7, 'WWRR'],
    ])
    expect(evaluate(capped, 'W')).toBeLessThan(WEIGHTS.line * 2)
  })

  it('gives a straight-through track no loop-threat value', () => {
    // A single cross carries two straight tracks; neither can ever loop
    // without help, so the position should be nearly balanced.
    const s = stateWith([[0, 0, 'WRWR']])
    expect(Math.abs(evaluate(s, 'W'))).toBeLessThanOrEqual(2 * 10) // at most the tempo terms
  })
})

describe('chooseMove', () => {
  it('finds a mate in one', () => {
    const s = stateWith(nearLoop, 'W')
    const r = chooseMove(s, testLimits(1))!
    const out = applyMove(s, r.move)
    expect(out.ok && out.state.result?.winner).toBe('W')
  })

  it('blocks the opponent’s mate in one without completing it', () => {
    // Red to move in the same position: white threatens to close its loop,
    // and red playing the closing tile itself also hands white the win.
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

  it('does not lose to a straight-line-building opponent', { timeout: 120_000 }, () => {
    // Regression for a reported loss: a human beat the AI by doing nothing but
    // stacking crosses into one straight line until it spanned LINE_SPAN. Play
    // that strategy as White against the AI at app-like strength and require
    // the AI to survive. The old span-only eval loses this game by ply 11.
    const whiteSpan = (s: GameState): number =>
      Math.max(0, ...components(s.board).filter((c) => c.color === 'W').map((c) => Math.max(c.spanX, c.spanY)))

    const redWinsNext = (s: GameState): boolean =>
      legalMoves(s).some((mv) => {
        const r = applyMove(s, mv)
        return r.ok && r.state.result?.winner === 'R'
      })

    // White's strategy: grow the longest white track, never hand red an
    // immediate win, and take any outright win on the spot.
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

    // ~1200 nodes matches what the app's 1.5s budget affords (depth 3-4).
    const limits = testLimits(5, { maxDepth: 16, maxNodes: 1200, topMargin: 5 })
    let state = newGame()
    while (!state.result && state.history.length < 60) {
      const mv = state.turn === 'W' ? lineBuilderMove(state) : chooseMove(state, limits)!.move
      state = play(state, [mv])
    }
    expect(state.result?.winner).not.toBe('W')
  })

  it('beats a random player', { timeout: 120_000 }, () => {
    let wins = 0
    let losses = 0
    for (let seed = 1; seed <= 4; seed++) {
      for (const aiColor of ['W', 'R'] as const) {
        const rand = rng(seed)
        const limits = testLimits(seed, { maxNodes: 20_000 })
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

describe('undoTo', () => {
  const s0 = newGame()
  const s1 = play(s0, [m(0, 0, 'RRWW')]) // W moved; R to play
  const s2 = play(s1, [m(1, 0, 'WRWR')]) // R moved; W to play
  const s3 = play(s2, [m(0, -1, 'RWRW')]) // W moved; R to play

  it('removes a full human+AI exchange', () => {
    expect(undoTo([s0, s1, s2, s3], 'W')).toEqual([s0, s1, s2])
    expect(undoTo([s0, s1, s2, s3], 'R')).toEqual([s0, s1])
  })

  it('removes a lone human move (undo while the computer thinks)', () => {
    expect(undoTo([s0, s1, s2], 'R')).toEqual([s0, s1])
    expect(undoTo([s0, s1], 'W')).toEqual([s0])
  })

  it('rewinds past a finished game to a live human turn', () => {
    const w1 = play(s0, [m(0, 0, 'RRWW')])
    const w2 = play(w1, [m(-1, 0, 'RWWR')])
    const w3 = play(w2, [m(0, 1, 'WRRW')]) // white closes its loop
    expect(w3.result?.winner).toBe('W')
    expect(undoTo([s0, w1, w2, w3], 'W')).toEqual([s0, w1, w2])
    expect(undoTo([s0, w1, w2, w3], 'R')).toEqual([s0, w1])
  })

  it('never underflows', () => {
    expect(undoTo([s0], 'W')).toEqual([s0])
    expect(undoTo([s0], 'R')).toEqual([s0])
  })
})
