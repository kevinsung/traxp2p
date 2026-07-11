import type { Coord, TileKind } from '../game/types'
import { TILE, TileGfx } from './Tile'

const MINI = 62
const GAP = 10

export interface TilePickerProps {
  cell: Coord
  tiles: TileKind[]
  onPick: (t: TileKind) => void
}

/** In-board popover listing the tiles that may be played on `cell`. */
export function TilePicker({ cell, tiles, onPick }: TilePickerProps) {
  const w = tiles.length * MINI + (tiles.length + 1) * GAP
  const h = MINI + 2 * GAP
  const cx = cell.x * TILE + TILE / 2
  const top = cell.y * TILE - h - 14
  return (
    <g transform={`translate(${cx - w / 2} ${top})`} className="tile-picker">
      <path
        d={`M ${w / 2 - 9} ${h} l 9 10 l 9 -10 Z`}
        className="picker-card"
      />
      <rect width={w} height={h} rx={12} className="picker-card" />
      {tiles.map((t, i) => (
        <g
          key={t}
          data-tile={t}
          className="picker-option"
          transform={`translate(${GAP + i * (MINI + GAP)} ${GAP})`}
          onClick={(e) => {
            e.stopPropagation()
            onPick(t)
          }}
        >
          <rect x={-3} y={-3} width={MINI + 6} height={MINI + 6} rx={8} className="picker-hit" />
          <g transform={`scale(${MINI / TILE})`}>
            <TileGfx tile={t} />
          </g>
        </g>
      ))}
    </g>
  )
}
