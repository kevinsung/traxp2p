import type { Color, Move, TileKind } from '../game/types'

/**
 * Request to the AI worker: board entries plus side to move. History and
 * result are not sent — the engine gates the first-move rule purely on board
 * size, and the AI is only consulted on live positions.
 */
export interface AIRequest {
  id: number
  board: [string, TileKind][]
  turn: Color
}

export interface AIResponse {
  id: number
  move: Move | null
  score: number
  depth: number
  nodes: number
}
