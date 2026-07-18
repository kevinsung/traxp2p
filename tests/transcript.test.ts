import { describe, expect, it } from 'vitest'
import { applyMove, newGame } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import { encodeMoves, replayTranscript } from '../src/game/transcript'
import type { GameState } from '../src/game/types'

// Deterministic PRNG (mulberry32) for reproducible random playouts.
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomGame(seed: number, plies: number): GameState {
  const rand = rng(seed)
  let state: GameState = newGame()
  for (let i = 0; i < plies && !state.result; i++) {
    const moves = legalMoves(state)
    if (moves.length === 0) break
    const move = moves[Math.floor(rand() * moves.length)]
    const out = applyMove(state, move)
    if (!out.ok) throw new Error(`unexpected illegal move: ${out.reason}`)
    state = out.state
  }
  return state
}

describe('transcript', () => {
  it('round-trips random playouts through encode/replay', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const game = randomGame(seed, 30)
      const text = encodeMoves(game.history)
      const r = replayTranscript(text)
      expect(r.ok).toBe(true)
      if (r.ok) {
        const replayed = r.line.at(-1)!
        expect(replayed.history.map((rec) => rec.notation)).toEqual(game.history.map((rec) => rec.notation))
        expect([...replayed.board.entries()].sort()).toEqual([...game.board.entries()].sort())
        expect(replayed.result).toEqual(game.result)
        // Every intermediate position is present too.
        expect(r.line).toHaveLength(game.history.length + 1)
      }
    }
  })

  it('replays an empty transcript to the empty board', () => {
    const r = replayTranscript('')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.line).toHaveLength(1)
      expect(r.line[0].board.size).toBe(0)
    }
  })

  it('tolerates surrounding whitespace and multiple spaces', () => {
    const s1 = applyMove(newGame(), { x: 0, y: 0, tile: 'RRWW' })
    if (!s1.ok) throw new Error(s1.reason)
    const s2 = applyMove(s1.state, { x: 1, y: 0, tile: 'WRWR' })
    if (!s2.ok) throw new Error(s2.reason)
    const spaced = `  ${encodeMoves(s2.state.history).replace(/ /g, '   ')}  `
    const r = replayTranscript(spaced)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.line).toHaveLength(s2.state.history.length + 1)
  })

  it('rejects a garbage token', () => {
    const r = replayTranscript('@0/ not-a-move')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/not a legal move/)
  })

  it('rejects a well-formed but illegal move', () => {
    // '+' at A1 with no board is malformed relative to the empty board's @0
    // convention; use a legal opening then an out-of-bounds-looking token
    // that decodes to no candidate tile.
    const r = replayTranscript('@0/ Z9+')
    expect(r.ok).toBe(false)
  })
})
