import type { Board, Coord, Dir } from './types'

export const DIRS: readonly Dir[] = [0, 1, 2, 3]

const DIR_OFFSETS: readonly Coord[] = [
  { x: 0, y: -1 }, // N
  { x: 1, y: 0 }, // E
  { x: 0, y: 1 }, // S
  { x: -1, y: 0 }, // W
]

export const opposite = (d: Dir): Dir => ((d + 2) % 4) as Dir

export const key = (x: number, y: number): string => `${x},${y}`

export function parseKey(k: string): Coord {
  const [x, y] = k.split(',').map(Number)
  return { x, y }
}

export function neighbor(x: number, y: number, d: Dir): Coord {
  return { x: x + DIR_OFFSETS[d].x, y: y + DIR_OFFSETS[d].y }
}

export interface Bounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
}

export function bounds(board: Board): Bounds | null {
  if (board.size === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const k of board.keys()) {
    const { x, y } = parseKey(k)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, maxX, minY, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
}
