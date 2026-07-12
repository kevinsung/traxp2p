import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../src/ai/arena'
import { cellOf, FastBoard, ILLEGAL, OK } from '../src/ai/fastboard'
import { positionHash } from '../src/ai/search'
import { key } from '../src/game/board'
import { applyMove, newGame } from '../src/game/engine'
import { candidateCells, legalMoves } from '../src/game/moves'
import { ALL_TILES, FIRST_TILES } from '../src/game/tiles'
import type { GameState, TileKind } from '../src/game/types'

/**
 * Differential tests: FastBoard must agree with the immutable engine — the
 * reference oracle — on legality, resulting state, terminal results, and
 * hashing, across random play. These tests are the correctness proof for
 * everything the v2 search builds on.
 */

const tileIdx = (t: TileKind): number => ALL_TILES.indexOf(t)

/** All (cell, tile) probes the engine considers at this position. */
function probes(state: GameState): Array<{ x: number; y: number; tile: TileKind }> {
  const tiles = state.board.size === 0 ? FIRST_TILES : ALL_TILES
  return candidateCells(state.board).flatMap((c) => tiles.map((tile) => ({ x: c.x, y: c.y, tile })))
}

/** Assert fb's full state (tiles, turn, hash, bounds) matches the engine's. */
function expectStateEqual(fb: FastBoard, state: GameState): void {
  const board = fb.toBoard()
  expect(board.size).toBe(state.board.size)
  for (const [k, t] of state.board) expect(board.get(k)).toBe(t)
  expect(fb.turn).toBe(state.turn === 'W' ? 0 : 1)
  expect(fb.hash()).toBe(positionHash(state.board, state.turn))
  if (state.board.size > 0) {
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const k of state.board.keys()) {
      const [x, y] = k.split(',').map(Number)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    expect([fb.minX, fb.maxX, fb.minY, fb.maxY]).toEqual([minX, maxX, minY, maxY])
  }
}

describe('FastBoard differential vs engine', () => {
  it('agrees with applyMove on legality for every candidate probe', { timeout: 300_000 }, () => {
    const rand = mulberry32(12345)
    for (let game = 0; game < 150; game++) {
      let state = newGame()
      const fb = FastBoard.fromState(state)
      for (let ply = 0; ply < 60 && !state.result; ply++) {
        for (const p of probes(state)) {
          const engineOk = applyMove(state, p).ok
          const r = fb.make(cellOf(p.x, p.y), tileIdx(p.tile))
          expect(r !== ILLEGAL, `probe (${p.x},${p.y},${p.tile}) at game ${game} ply ${ply}`).toBe(engineOk)
          if (r !== ILLEGAL) fb.unmake()
        }
        const moves = legalMoves(state)
        const mv = moves[Math.floor(rand() * moves.length)]
        const out = applyMove(state, mv)
        if (!out.ok) throw new Error('random legal move rejected')
        state = out.state
        expect(fb.make(cellOf(mv.x, mv.y), tileIdx(mv.tile))).not.toBe(ILLEGAL)
      }
    }
  })

  it('tracks the engine state and terminal results through random games', { timeout: 300_000 }, () => {
    const rand = mulberry32(777)
    for (let game = 0; game < 200; game++) {
      let state = newGame()
      const fb = FastBoard.fromState(state)
      for (let ply = 0; ply < 100 && !state.result; ply++) {
        const moves = legalMoves(state)
        const mv = moves[Math.floor(rand() * moves.length)]
        const out = applyMove(state, mv)
        if (!out.ok) throw new Error('random legal move rejected')
        const r = fb.make(cellOf(mv.x, mv.y), tileIdx(mv.tile))
        expect(r).not.toBe(ILLEGAL)
        state = out.state
        expectStateEqual(fb, state)
        if (state.result) {
          const expected = state.result.winner === 'W' ? 1 : 2
          expect(r, `game ${game} ply ${ply}: winner mismatch`).toBe(expected)
        } else {
          expect(r, `game ${game} ply ${ply}: phantom win`).toBe(OK)
        }
      }
    }
  })

  it('restores tiles, hash, and bounds exactly through make/unmake walks', { timeout: 300_000 }, () => {
    const rand = mulberry32(31337)
    for (let walk = 0; walk < 100; walk++) {
      let state = newGame()
      const fb = FastBoard.fromState(state)
      // Play a random prefix so walks start from varied positions.
      const prefixLen = Math.floor(rand() * 30)
      for (let i = 0; i < prefixLen && !state.result; i++) {
        const moves = legalMoves(state)
        const mv = moves[Math.floor(rand() * moves.length)]
        const out = applyMove(state, mv)
        if (!out.ok) throw new Error('random legal move rejected')
        state = out.state
        fb.make(cellOf(mv.x, mv.y), tileIdx(mv.tile))
      }
      if (state.result) continue

      // Random probes, some illegal (rolled back inside make), some made and
      // later unmade; at the end the board must be bit-identical to a fresh
      // rebuild of the prefix position.
      const made: number[] = []
      const tiles = state.board.size === 0 ? FIRST_TILES : ALL_TILES
      let probeState = state
      for (let step = 0; step < 40; step++) {
        const cs = candidateCells(probeState.board)
        const c = cs[Math.floor(rand() * cs.length)]
        const tile = tiles[Math.floor(rand() * tiles.length)]
        const engineOut = applyMove(probeState, { x: c.x, y: c.y, tile })
        const r = fb.make(cellOf(c.x, c.y), tileIdx(tile))
        expect(r !== ILLEGAL).toBe(engineOut.ok)
        if (engineOut.ok && r !== ILLEGAL) {
          if (engineOut.state.result || rand() < 0.3) {
            fb.unmake() // pop terminal or randomly back out
          } else {
            made.push(1)
            probeState = engineOut.state
          }
        }
      }
      while (made.length > 0) {
        fb.unmake()
        made.pop()
      }
      const fresh = FastBoard.fromState(state)
      expectStateEqual(fb, state)
      expect(fb.hash()).toBe(fresh.hash())
      expect(fb.depth()).toBe(state.history.length)
    }
  })

  it('generates a move superset of legalMoves and make() filters it exactly', { timeout: 300_000 }, () => {
    const rand = mulberry32(99)
    for (let game = 0; game < 60; game++) {
      let state = newGame()
      const fb = FastBoard.fromState(state)
      const buf: number[] = []
      for (let ply = 0; ply < 60 && !state.result; ply++) {
        fb.moves(buf)
        const generated = new Set(buf)
        // Every engine-legal move must be generated…
        const legal = legalMoves(state)
        for (const mv of legal) {
          expect(generated.has(cellOf(mv.x, mv.y) * 8 + tileIdx(mv.tile))).toBe(true)
        }
        // …and make() must accept exactly the legal subset.
        const legalSet = new Set(legal.map((mv) => cellOf(mv.x, mv.y) * 8 + tileIdx(mv.tile)))
        for (const packed of buf) {
          const r = fb.make(Math.floor(packed / 8), packed & 7)
          expect(r !== ILLEGAL).toBe(legalSet.has(packed))
          if (r !== ILLEGAL) fb.unmake()
        }
        const mv = legal[Math.floor(rand() * legal.length)]
        const out = applyMove(state, mv)
        if (!out.ok) throw new Error('random legal move rejected')
        state = out.state
        fb.make(cellOf(mv.x, mv.y), tileIdx(mv.tile))
      }
    }
  })

  it('round-trips fromState/toBoard on a nontrivial position', () => {
    const state = newGame()
    let s = state
    for (const mv of [
      { x: 0, y: 0, tile: 'RRWW' as TileKind },
      { x: -1, y: 0, tile: 'RWWR' as TileKind },
    ]) {
      const out = applyMove(s, mv)
      if (!out.ok) throw new Error(out.reason)
      s = out.state
    }
    const fb = FastBoard.fromState(s)
    expect(fb.toBoard()).toEqual(s.board)
    expect(fb.toBoard().get(key(0, 0))).toBe('RRWW')
    expect(fb.hash()).toBe(positionHash(s.board, s.turn))
  })
})
