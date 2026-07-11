import { describe, expect, it } from 'vitest'
import { key } from '../src/game/board'
import { applyMove, newGame } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import { decodeMove, encodeMove, symbolOf } from '../src/game/notation'
import type { Board, GameState } from '../src/game/types'

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

describe('notation', () => {
  it('encodes the two openings', () => {
    expect(encodeMove(new Map(), { x: 0, y: 0, tile: 'WRWR' })).toBe('@0+')
    expect(encodeMove(new Map(), { x: 0, y: 0, tile: 'RRWW' })).toBe('@0/')
  })

  it('uses @ and 0 for cells left of / above the current bounding box', () => {
    const board: Board = new Map([[key(0, 0), 'RRWW']])
    expect(encodeMove(board, { x: -1, y: 0, tile: 'RWWR' })).toBe('@1\\')
    expect(encodeMove(board, { x: 0, y: -1, tile: 'WRRW' })).toBe('A0\\')
    expect(encodeMove(board, { x: 1, y: 0, tile: 'WRWR' })).toBe('B1+')
  })

  it('decodes the openings', () => {
    expect(decodeMove(new Map(), '@0+')).toEqual({ x: 0, y: 0, tile: 'WRWR' })
    expect(decodeMove(new Map(), '@0/')).toEqual({ x: 0, y: 0, tile: 'RRWW' })
    expect(decodeMove(new Map(), 'A1+')).toBeNull()
  })

  it('handles columns beyond Z', () => {
    // A row of 27 horizontal crosses; the cell east of it is column AB.
    const board: Board = new Map()
    for (let x = 0; x < 27; x++) board.set(key(x, 0), 'RWRW')
    const move = { x: 27, y: 0, tile: 'RWRW' } as const
    expect(encodeMove(board, move)).toBe('AB1+')
    expect(decodeMove(board, 'AB1+')).toEqual(move)
  })

  it('round-trips every move of random playouts', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const rand = rng(seed)
      let state: GameState = newGame()
      for (let i = 0; i < 30 && !state.result; i++) {
        const moves = legalMoves(state)
        expect(moves.length).toBeGreaterThan(0)
        const move = moves[Math.floor(rand() * moves.length)]
        const text = encodeMove(state.board, move)
        expect(symbolOf(move.tile)).toBe(text.at(-1))
        expect(decodeMove(state.board, text)).toEqual(move)
        const out = applyMove(state, move)
        expect(out.ok).toBe(true)
        if (out.ok) {
          expect(out.state.history.at(-1)!.notation).toBe(text)
          state = out.state
        }
      }
    }
  })
})
