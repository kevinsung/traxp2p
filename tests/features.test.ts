import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../src/ai/arena'
import { FastBoard } from '../src/ai/fastboard'
import {
  dot,
  extractVerified,
  F_LINE_DOUBLE,
  F_WAITER_OPEN,
  FEATURE_COUNT,
  FEATURE_NAMES,
  HAND,
} from '../src/ai/features'
import { evalWhite } from '../src/ai/search2'
import { applyMove, newGame } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import { replayTranscript } from '../src/game/transcript'
import type { Board, GameState, TileKind } from '../src/game/types'

/**
 * The two properties src/ai/features.ts exists to guarantee.
 *
 * 1. **Nesting.** `HAND · extractCore(fb) === evalWhite(fb)`, so every fitted
 *    weight on a candidate slot reads as an increment over the shipped eval
 *    rather than as an unmoored number. This is also the drift guard: the `ml`
 *    branch carried a hand-transcribed copy of the eval's weights that went
 *    stale within two weeks, and nothing noticed.
 * 2. **Antisymmetry.** Every slot negates when both tile colors and the side to
 *    move are swapped. Negamax over a fitted weight vector is only sound if this
 *    holds, and a sign slip in a new slot has no other guard at all.
 */

/** Swap a tile's colors: W↔R. Every result is a real tile (2 of each edge). */
const swapTile = (t: TileKind): TileKind =>
  t.replace(/[WR]/g, (c) => (c === 'W' ? 'R' : 'W')) as TileKind

/**
 * The color-swapped position. Legal by construction — edge matching and the
 * forced-fill rule are both color-blind — and built through `fromState`, which
 * inserts without re-checking legality, since the swapped *first* tile is not
 * one of the two the opening rule allows.
 */
function swapColors(state: GameState): GameState {
  const board: Board = new Map()
  for (const [k, t] of state.board) board.set(k, swapTile(t))
  return { board, turn: state.turn === 'W' ? 'R' : 'W', history: [], result: null }
}

/** Positions from uniformly random legal play — the generator tests/ai2.test.ts uses. */
function* randomPositions(seeds: number, plies: number): Generator<GameState> {
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed)
    let state: GameState = newGame()
    for (let ply = 0; ply < plies && !state.result; ply++) {
      const moves = legalMoves(state)
      const out = applyMove(state, moves[Math.floor(rand() * moves.length)])
      if (!out.ok) throw new Error(`random play produced an illegal move: ${out.reason}`)
      state = out.state
      if (state.result) break
      yield state
    }
  }
}

const buf = new Float64Array(FEATURE_COUNT)
const swapBuf = new Float64Array(FEATURE_COUNT)

/**
 * Slots random play does not reach often enough to assert on: `line_double`
 * fires in ~0.6% of random positions and `waiter_open` — a fork whose two
 * closing cells are ≥3 apart — in ~0.1%. Both get a pinned position below
 * instead, found by sweeping 800 random games.
 */
const RARE = new Set([F_LINE_DOUBLE, F_WAITER_OPEN])

describe('features', () => {
  it('nests the shipped eval and negates under a color swap', { timeout: 120_000 }, () => {
    let checked = 0
    let skipped = 0
    const seen = new Array<number>(FEATURE_COUNT).fill(0)

    for (const state of randomPositions(60, 60)) {
      const fb = FastBoard.fromState(state)
      // Read the hand score before extraction: extractVerified plays and
      // unplays moves on `fb`, and while it restores the board exactly, the
      // eval should not be reading a board something else has been touching.
      const hand = evalWhite(fb)
      const info = extractVerified(fb, buf)
      // A verified win in one is outside the corpus: evalWhite *replaces* its
      // score with ±winInOne there, so the nesting identity does not apply.
      if (info.moverWins) {
        skipped++
        expect(Math.abs(hand)).toBe(500_000)
        continue
      }
      checked++
      for (let j = 0; j < FEATURE_COUNT; j++) if (buf[j] !== 0) seen[j]++

      // The two sides sum the same per-component floats in the same order but
      // into different accumulators, so compare closely rather than bit-exactly
      // — the same tolerance tests/ai2.test.ts's twin check uses.
      expect(dot(HAND, buf), `HAND·f vs evalWhite at ${state.board.size} tiles`).toBeCloseTo(hand, 9)

      extractVerified(FastBoard.fromState(swapColors(state)), swapBuf)
      for (let j = 0; j < FEATURE_COUNT; j++) {
        expect(swapBuf[j], `${FEATURE_NAMES[j]} under color swap`).toBeCloseTo(-buf[j], 9)
      }
    }

    expect(checked).toBeGreaterThan(400)
    expect(skipped).toBeGreaterThan(0) // the exclusion is exercised, not hypothetical
    for (let j = 0; j < FEATURE_COUNT; j++) {
      if (RARE.has(j)) continue
      expect(seen[j], `${FEATURE_NAMES[j]} was never nonzero`).toBeGreaterThan(0)
    }
  })

  /**
   * The two rare slots, on positions found by sweeping 800 random games. Pinned
   * rather than searched for at test time: reaching them reliably costs ~80s of
   * random play, and one position each proves the same two properties.
   */
  const pinned: Array<{ slot: number; value: number; transcript: string }> = [
    {
      slot: F_LINE_DOUBLE,
      value: 1,
      transcript:
        '@0/ A0+ @2/ B3/ B4\\ A0\\ C3/ B6\\ C6/ C7\\ C1/ A0/ D8\\ D4/ @2+ F3+ @2\\ C6/ E9/ G7\\ H7+ G9/ H2\\ A1/ B6/ @2/ J8+ H10/',
    },
    {
      slot: F_WAITER_OPEN,
      value: -1,
      transcript:
        '@0+ B1/ B0\\ B0\\ B0\\ C2+ B5+ B6/ B7/ A5/ A2/ B8+ @5\\ E1+ E0\\ B8\\ D8+ B9+ E7\\ B1\\ C1+ A3/ B0/ A9\\ @7+ A9/ E1\\ G8\\ G1+ A4+ H2+ F0/ G11\\ I3/ G12\\ A7+ @6/ E12\\ H1+ @7+ D12\\ C12/ J9\\ J1/',
    },
  ]

  for (const { slot, value, transcript } of pinned) {
    it(`covers ${FEATURE_NAMES[slot]}, and it negates under a color swap`, () => {
      const replay = replayTranscript(transcript)
      expect(replay.ok, replay.ok ? '' : replay.error).toBe(true)
      if (!replay.ok) return
      const state = replay.line[replay.line.length - 1]
      const fb = FastBoard.fromState(state)
      const hand = evalWhite(fb)
      const info = extractVerified(fb, buf)
      expect(info.moverWins).toBe(false)
      expect(buf[slot]).toBe(value)
      expect(dot(HAND, buf)).toBeCloseTo(hand, 9)

      extractVerified(FastBoard.fromState(swapColors(state)), swapBuf)
      for (let j = 0; j < FEATURE_COUNT; j++) {
        expect(swapBuf[j], `${FEATURE_NAMES[j]} under color swap`).toBeCloseTo(-buf[j], 9)
      }
    })
  }
})
