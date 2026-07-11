import { isCross } from '../game/tiles'
import type { Color, Dir, TileKind } from '../game/types'

/** Side length of one tile in board units. */
export const TILE = 100

const MID: Record<Dir, [number, number]> = {
  0: [50, 0],
  1: [100, 50],
  2: [50, 100],
  3: [0, 50],
}

// Sweep flags for corner-hugging quarter arcs between adjacent edge
// midpoints, keyed by the ascending direction pair.
const ARC_SWEEP: Record<string, 0 | 1> = { '0,1': 0, '1,2': 0, '2,3': 0, '0,3': 1 }

function dirsOf(tile: TileKind, color: Color): [Dir, Dir] {
  const ds = ([0, 1, 2, 3] as const).filter((d) => tile[d] === color)
  return [ds[0], ds[1]]
}

export function trackPath(tile: TileKind, color: Color): string {
  const [a, b] = dirsOf(tile, color)
  const [ax, ay] = MID[a]
  const [bx, by] = MID[b]
  if (b - a === 2) return `M ${ax} ${ay} L ${bx} ${by}`
  return `M ${ax} ${ay} A 50 50 0 0 ${ARC_SWEEP[`${a},${b}`]} ${bx} ${by}`
}

export interface TileGfxProps {
  tile: TileKind
  /** Draw a winning-track glow over this color's track. */
  highlight?: Color | null
}

/** One tile as an SVG group spanning TILE x TILE units at the origin. */
export function TileGfx({ tile, highlight }: TileGfxProps) {
  const red = trackPath(tile, 'R')
  const white = trackPath(tile, 'W')
  return (
    <g>
      <rect x={2} y={2} width={TILE - 4} height={TILE - 4} rx={9} className="tile-bg" />
      <path d={red} className="track track-R" />
      {/* On crosses the white track bridges over the red one. */}
      {isCross(tile) && <path d={white} className="track-casing" />}
      <path d={white} className="track track-W" />
      {highlight && <path d={trackPath(tile, highlight)} className="track-win" />}
    </g>
  )
}
