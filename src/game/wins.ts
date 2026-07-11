import { bounds, key, neighbor, opposite } from './board'
import { edgeColor, otherEnd } from './tiles'
import type { Board, Color, Coord, Dir, PlacedTile, WinPath } from './types'

/** A line win must span at least this many rows or columns. */
export const LINE_SPAN = 8

interface OpenEnd extends Coord {
  /** Direction in which the track leaves cell (x,y) into empty space. */
  d: Dir
}

/**
 * Find every loop and line win on tracks passing through the given tiles.
 * Adjacent tiles always have matching edge colors (an engine invariant), and
 * each tile carries exactly one segment per color, so each color's track
 * through a tile extends to a unique simple path or loop.
 */
export function detectWins(board: Board, through: PlacedTile[]): WinPath[] {
  const wins: WinPath[] = []
  const b = bounds(board)
  if (!b) return wins
  const visited = new Set<string>() // `${cellKey}|${color}`

  for (const t of through) {
    for (const color of ['W', 'R'] as const) {
      if (visited.has(`${key(t.x, t.y)}|${color}`)) continue
      const trk = trace(board, t.x, t.y, color, visited)
      if (trk.loop) {
        wins.push({ color, kind: 'loop', cells: trk.cells })
        continue
      }
      const [a, z] = trk.ends!
      const horizontal =
        (exits(a, 3, b.minX) && exits(z, 1, b.maxX)) ||
        (exits(z, 3, b.minX) && exits(a, 1, b.maxX))
      const vertical =
        (exitsRow(a, 0, b.minY) && exitsRow(z, 2, b.maxY)) ||
        (exitsRow(z, 0, b.minY) && exitsRow(a, 2, b.maxY))
      if ((horizontal && b.width >= LINE_SPAN) || (vertical && b.height >= LINE_SPAN)) {
        wins.push({ color, kind: 'line', cells: trk.cells })
      }
    }
  }
  return wins
}

const exits = (e: OpenEnd, d: Dir, edgeX: number): boolean => e.d === d && e.x === edgeX
const exitsRow = (e: OpenEnd, d: Dir, edgeY: number): boolean => e.d === d && e.y === edgeY

interface Track {
  cells: string[]
  loop: boolean
  ends?: [OpenEnd, OpenEnd]
}

function trace(board: Board, startX: number, startY: number, color: Color, visited: Set<string>): Track {
  const startTile = board.get(key(startX, startY))!
  const [d1, d2] = ([0, 1, 2, 3] as const).filter((d) => edgeColor(startTile, d) === color)
  const cells = [key(startX, startY)]
  visited.add(`${key(startX, startY)}|${color}`)

  const walk = (d: Dir): OpenEnd | 'loop' => {
    let x = startX
    let y = startY
    for (;;) {
      const n = neighbor(x, y, d)
      const nt = board.get(key(n.x, n.y))
      if (!nt) return { x, y, d }
      // Re-entering the start tile closes the loop: any entry on this color
      // must use one of its two color ports, and we left through the other.
      if (n.x === startX && n.y === startY) return 'loop'
      cells.push(key(n.x, n.y))
      visited.add(`${key(n.x, n.y)}|${color}`)
      const dOut = otherEnd(nt, opposite(d))
      x = n.x
      y = n.y
      d = dOut
    }
  }

  const endA = walk(d1)
  if (endA === 'loop') return { cells, loop: true }
  const endB = walk(d2) as OpenEnd // a simple path cannot loop from one side only
  return { cells, loop: false, ends: [endA, endB] }
}
