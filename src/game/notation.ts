import { bounds, DIRS, key, neighbor, opposite } from './board'
import { ALL_TILES, edgeColor, isCross } from './tiles'
import type { Board, Move, TileKind } from './types'

/**
 * Standard Trax notation: column label + row number + tile symbol, relative
 * to the bounding box of the position BEFORE the move. Columns are lettered
 * A.. from the leftmost occupied column, with '@' for the column left of it;
 * rows are numbered 1.. from the topmost occupied row, with 0 for the row
 * above it. The first move is always "@0+" or "@0/".
 *
 * Tile symbols: '+' is a cross; '/' is a curve whose arcs hug the NE and SW
 * corners; '\' hugs NW and SE. The neighbor constraints at the target space
 * always disambiguate which coloring is meant.
 */
export type TileSymbol = '+' | '/' | '\\'

export function symbolOf(tile: TileKind): TileSymbol {
  if (isCross(tile)) return '+'
  return tile === 'WWRR' || tile === 'RRWW' ? '/' : '\\'
}

function colLabel(i: number): string {
  if (i === 0) return '@'
  let s = ''
  while (i > 0) {
    i--
    s = String.fromCharCode(65 + (i % 26)) + s
    i = Math.floor(i / 26)
  }
  return s
}

function colIndex(label: string): number {
  if (label === '@') return 0
  let i = 0
  for (const ch of label) i = i * 26 + (ch.charCodeAt(0) - 64)
  return i
}

export function encodeMove(board: Board, move: Move): string {
  const sym = symbolOf(move.tile)
  const b = bounds(board)
  if (!b) return `@0${sym}`
  return `${colLabel(move.x - b.minX + 1)}${move.y - b.minY + 1}${sym}`
}

export function decodeMove(board: Board, text: string): Move | null {
  const m = /^(@|[A-Z]+)([0-9]+)([+/\\])$/.exec(text.trim().toUpperCase())
  if (!m) return null
  const [, colS, rowS, sym] = m
  const b = bounds(board)
  if (!b) {
    if (colS !== '@' || rowS !== '0') return null
    return sym === '+' ? { x: 0, y: 0, tile: 'WRWR' } : sym === '/' ? { x: 0, y: 0, tile: 'RRWW' } : null
  }
  const x = b.minX - 1 + colIndex(colS)
  const y = b.minY - 1 + parseInt(rowS, 10)
  // The symbol names a pair of complementary tiles; any adjacent tile's edge
  // constraint picks exactly one of them.
  const candidates = ALL_TILES.filter((t) => symbolOf(t) === sym && edgesMatch(board, x, y, t))
  return candidates.length === 1 ? { x, y, tile: candidates[0] } : null
}

function edgesMatch(board: Board, x: number, y: number, t: TileKind): boolean {
  if (board.has(key(x, y))) return false
  let touches = false
  for (const d of DIRS) {
    const n = neighbor(x, y, d)
    const nt = board.get(key(n.x, n.y))
    if (!nt) continue
    touches = true
    if (edgeColor(nt, opposite(d)) !== edgeColor(t, d)) return false
  }
  return touches
}
