import { describe, expect, it } from 'vitest'
import { key } from '../src/game/board'
import { applyMove, hashState, newGame, resign } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import type { Board, GameState, Move, TileKind } from '../src/game/types'

function play(state: GameState, moves: Move[]): GameState {
  for (const m of moves) {
    const out = applyMove(state, m)
    if (!out.ok) throw new Error(`move ${JSON.stringify(m)} rejected: ${out.reason}`)
    state = out.state
  }
  return state
}

function stateWith(tiles: Array<[number, number, TileKind]>, turn: 'W' | 'R' = 'W'): GameState {
  const board: Board = new Map(tiles.map(([x, y, t]) => [key(x, y), t]))
  return { board, turn, history: [], result: null }
}

const m = (x: number, y: number, tile: TileKind): Move => ({ x, y, tile })

describe('first move', () => {
  it('offers exactly the two canonical openings at the origin', () => {
    const moves = legalMoves(newGame())
    expect(moves).toHaveLength(2)
    expect(moves.every((mv) => mv.x === 0 && mv.y === 0)).toBe(true)
    expect(new Set(moves.map((mv) => mv.tile))).toEqual(new Set(['WRWR', 'RRWW']))
  })

  it('rejects first moves off the origin or with non-canonical tiles', () => {
    expect(applyMove(newGame(), m(1, 0, 'WRWR')).ok).toBe(false)
    expect(applyMove(newGame(), m(0, 0, 'RWRW')).ok).toBe(false)
  })
})

describe('placement rules', () => {
  const base = play(newGame(), [m(0, 0, 'RRWW')])

  it('rejects occupied cells', () => {
    expect(applyMove(base, m(0, 0, 'WRWR')).ok).toBe(false)
  })

  it('rejects non-adjacent cells', () => {
    expect(applyMove(base, m(2, 0, 'WRWR')).ok).toBe(false)
  })

  it('rejects mismatched edges', () => {
    // (0,0)=RRWW has E=R, so the new tile's W edge must be R, not W.
    expect(applyMove(base, m(1, 0, 'RRWW')).ok).toBe(false)
    expect(applyMove(base, m(1, 0, 'WRWR')).ok).toBe(true)
  })

  it('rejects any move after the game is over', () => {
    const done = resign(base, 'W')
    expect(applyMove(done, m(1, 0, 'WRWR')).ok).toBe(false)
  })
})

describe('forced play', () => {
  it('fills a space that gains two same-colored edges', () => {
    // (0,-1)=RWRW gives (1,-1) a white edge from the west; (1,0)=WRWR gives
    // it a white edge from the south -> forced RRWW at (1,-1).
    const s = play(newGame(), [m(0, 0, 'RRWW'), m(1, 0, 'WRWR'), m(0, -1, 'RWRW')])
    expect(s.board.get(key(1, -1))).toBe('RRWW')
    const last = s.history.at(-1)!
    expect(last.placed).toHaveLength(2)
    expect(last.placed[1]).toEqual({ x: 1, y: -1, tile: 'RRWW', forced: true })
  })

  it('cascades: a forced tile can force another space', () => {
    // As above, but (2,-2)=WRRW presents a red edge down at (2,-1). The
    // forced RRWW at (1,-1) presents a red edge east at (2,-1) too -> a
    // second forced tile RWWR at (2,-1).
    const s0 = stateWith([
      [0, 0, 'RRWW'],
      [1, 0, 'WRWR'],
      [2, -2, 'WRRW'],
    ])
    const out = applyMove(s0, m(0, -1, 'RWRW'))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.state.board.get(key(1, -1))).toBe('RRWW')
    expect(out.state.board.get(key(2, -1))).toBe('RWWR')
    expect(out.state.history.at(-1)!.placed.filter((p) => p.forced)).toHaveLength(2)
  })

  it('rejects a move that forces an impossible space', () => {
    // Placing WRRW at (2,1) gives (1,1) a third white edge (after the white
    // edges from (1,0) and (0,1)) - no tile has three white edges.
    const s0 = stateWith([
      [1, 0, 'WRWR'],
      [0, 1, 'RWRW'],
      [2, 0, 'WRWR'],
    ])
    const out = applyMove(s0, m(2, 1, 'WRRW'))
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/no tile can fill/)
  })
})

describe('winning', () => {
  it('detects a loop completed by a forced tile, won by the mover', () => {
    // White's third move (WRRW at (0,1)) forces WWRR at (-1,1), closing a
    // 2x2 white loop.
    const s = play(newGame(), [m(0, 0, 'RRWW'), m(-1, 0, 'RWWR'), m(0, 1, 'WRRW')])
    expect(s.result).not.toBeNull()
    expect(s.result!.winner).toBe('W')
    expect(s.result!.reason).toBe('loop')
    expect(s.result!.paths[0].cells).toHaveLength(4)
  })

  it('awards a loop to its owner even when the opponent completes it', () => {
    // Same position, but now it is Red who plays the closing move.
    const s0 = stateWith(
      [
        [0, 0, 'RRWW'],
        [-1, 0, 'RWWR'],
      ],
      'R',
    )
    const out = applyMove(s0, m(0, 1, 'WRRW'))
    expect(out.ok && out.state.result?.winner).toBe('W')
  })

  it('detects a line spanning 8 rows but not 7', () => {
    // A vertical stack of WRWR crosses carries one long white track.
    let s = play(newGame(), [m(0, 0, 'WRWR')])
    for (let y = 1; y < 7; y++) s = play(s, [m(0, y, 'WRWR')])
    expect(s.result).toBeNull()
    s = play(s, [m(0, 7, 'WRWR')])
    expect(s.result).not.toBeNull()
    expect(s.result!.winner).toBe('W')
    expect(s.result!.reason).toBe('line')
    expect(s.result!.paths[0].cells).toHaveLength(8)
  })

  it('gives a simultaneous double win to the mover', () => {
    // A plus of WRWR crosses missing its center: filling it completes both
    // the white vertical line (8 rows) and the red horizontal line (8 cols).
    const tiles: Array<[number, number, TileKind]> = []
    for (let y = 0; y < 8; y++) if (y !== 3) tiles.push([0, y, 'WRWR'])
    for (let x = -4; x < 4; x++) if (x !== 0) tiles.push([x, 3, 'WRWR'])
    for (const turn of ['W', 'R'] as const) {
      const out = applyMove(stateWith(tiles, turn), m(0, 3, 'WRWR'))
      expect(out.ok && out.state.result?.winner).toBe(turn)
    }
  })

  it('handles resignation', () => {
    const s = resign(play(newGame(), [m(0, 0, 'RRWW')]), 'R')
    expect(s.result).toEqual({ winner: 'W', reason: 'resignation', paths: [] })
  })
})

describe('hashState', () => {
  it('is independent of board insertion order and sensitive to turn', () => {
    const a = stateWith([
      [0, 0, 'RRWW'],
      [1, 0, 'WRWR'],
    ])
    const b = stateWith([
      [1, 0, 'WRWR'],
      [0, 0, 'RRWW'],
    ])
    expect(hashState(a)).toBe(hashState(b))
    expect(hashState(a)).not.toBe(hashState({ ...a, turn: 'R' }))
  })
})
