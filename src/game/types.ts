export type Color = 'W' | 'R'

/** Direction indices: 0 = North, 1 = East, 2 = South, 3 = West. */
export type Dir = 0 | 1 | 2 | 3

/**
 * A tile is named by the colors of its four edges in N,E,S,W order.
 * Every Trax tile has exactly two white and two red edges, and same-colored
 * edges are joined by that color's track — so the name fully determines the
 * tile. Opposite same-colored edges form a cross; adjacent ones a curve.
 */
export type TileKind = 'WRWR' | 'RWRW' | 'WWRR' | 'RWWR' | 'RRWW' | 'WRRW'

export interface Coord {
  x: number
  y: number
}

export interface Move extends Coord {
  tile: TileKind
}

export interface PlacedTile extends Move {
  forced: boolean
}

/** Sparse unbounded board, keyed by `"x,y"`. */
export type Board = Map<string, TileKind>

export interface WinPath {
  color: Color
  kind: 'loop' | 'line'
  /** Board keys of every cell the winning track passes through. */
  cells: string[]
}

export interface GameResult {
  winner: Color
  reason: 'loop' | 'line' | 'resignation'
  /** The winner's winning track(s); empty for resignation. */
  paths: WinPath[]
}

export interface MoveRecord {
  player: Color
  move: Move
  /** The played tile first, then forced tiles in placement order. */
  placed: PlacedTile[]
  notation: string
}

export interface GameState {
  board: Board
  turn: Color
  history: MoveRecord[]
  result: GameResult | null
}
