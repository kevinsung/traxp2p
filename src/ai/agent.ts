import { legalMoves } from '../game/moves'
import type { GameState, Move } from '../game/types'
import type { SearchLimits, SearchResult } from './search'

/**
 * A player that can pick a move in any non-terminal GameState. This is the
 * common interface the arena (arena.ts) plays against, so any AI
 * implementation — or a trivial baseline — can be pitted against another
 * without the arena knowing how either one works.
 */
export interface Agent {
  name: string
  move(state: GameState, rand: () => number): Move
}

/**
 * Wrap a `chooseMove`-shaped search function as an Agent. The arena's seeded
 * `rand` is threaded into a copy of `limits` on every call so a whole match
 * is reproducible regardless of what random source the caller configured.
 */
export function searchAgent(
  name: string,
  chooseFn: (state: GameState, limits: SearchLimits) => SearchResult | null,
  limits: SearchLimits,
): Agent {
  return {
    name,
    move(state, rand) {
      const r = chooseFn(state, { ...limits, rand })
      if (!r) throw new Error(`agent "${name}" returned no move for a non-terminal state`)
      return r.move
    },
  }
}

/** Baseline agent: plays uniformly at random among legal moves. */
export function randomAgent(name = 'random'): Agent {
  return {
    name,
    move(state, rand) {
      const moves = legalMoves(state)
      if (moves.length === 0) throw new Error(`agent "${name}" has no legal move`)
      return moves[Math.floor(rand() * moves.length)]
    },
  }
}
