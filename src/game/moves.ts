import { DIRS, key, neighbor, parseKey } from './board'
import { applyMove } from './engine'
import { ALL_TILES, FIRST_TILES } from './tiles'
import type { Board, Coord, GameState, Move, TileKind } from './types'

/** Empty cells where a tile could be placed (ignoring tile legality). */
export function candidateCells(board: Board): Coord[] {
  if (board.size === 0) return [{ x: 0, y: 0 }]
  const seen = new Set<string>()
  const out: Coord[] = []
  for (const k of board.keys()) {
    const { x, y } = parseKey(k)
    for (const d of DIRS) {
      const n = neighbor(x, y, d)
      const nk = key(n.x, n.y)
      if (board.has(nk) || seen.has(nk)) continue
      seen.add(nk)
      out.push(n)
    }
  }
  return out
}

/** Tiles that can legally be played at `cell` (edge match + legal cascade). */
export function legalTilesAt(state: GameState, cell: Coord): TileKind[] {
  const tiles = state.board.size === 0 ? FIRST_TILES : ALL_TILES
  return tiles.filter((tile) => applyMove(state, { ...cell, tile }).ok)
}

export function legalMoves(state: GameState): Move[] {
  if (state.result) return []
  return candidateCells(state.board).flatMap((c) =>
    legalTilesAt(state, c).map((tile) => ({ ...c, tile })),
  )
}
