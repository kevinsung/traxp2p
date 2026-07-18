import type { ReactNode } from 'react'
import { Logo } from './Logo'
import { TILE, TileGfx } from './Tile'
import type { Color, TileKind } from '../game/types'

export interface RulesProps {
  onBack: () => void
}

interface Cell {
  x: number
  y: number
  tile: TileKind
  /** Draw the dashed "forced play" outline used in-game. */
  forced?: boolean
}

/** A static, non-interactive board fragment for the rules illustrations. */
function MiniBoard({
  cells,
  empty = [],
  highlight,
  width: cssWidth,
}: {
  cells: Cell[]
  empty?: Array<{ x: number; y: number }>
  /** Glow this color's track on every tile (used for the win figures). */
  highlight?: Color
  width: number
}) {
  const all = [...cells, ...empty]
  const xs = all.map((c) => c.x)
  const ys = all.map((c) => c.y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const w = Math.max(...xs) - minX + 1
  const h = Math.max(...ys) - minY + 1
  const pad = 6
  const vb = `${minX * TILE - pad} ${minY * TILE - pad} ${w * TILE + 2 * pad} ${h * TILE + 2 * pad}`
  return (
    <svg className="mini-board" viewBox={vb} style={{ width: cssWidth, height: (cssWidth * (h * TILE + 2 * pad)) / (w * TILE + 2 * pad) }}>
      {empty.map(({ x, y }) => (
        <rect
          key={`e${x},${y}`}
          className="rules-empty"
          x={x * TILE + 6}
          y={y * TILE + 6}
          width={TILE - 12}
          height={TILE - 12}
          rx={10}
        />
      ))}
      {cells.map(({ x, y, tile, forced }) => (
        <g key={`${x},${y}`} transform={`translate(${x * TILE} ${y * TILE})`}>
          <TileGfx tile={tile} highlight={highlight} />
          {forced && <rect x={2} y={2} width={TILE - 4} height={TILE - 4} rx={9} className="last-move forced" />}
        </g>
      ))}
    </svg>
  )
}

function Figure({ children, caption, tone }: { children: ReactNode; caption: string; tone?: 'ok' | 'bad' }) {
  return (
    <figure className="rules-figure">
      {children}
      <figcaption className={tone ? `fig-${tone}` : undefined}>{caption}</figcaption>
    </figure>
  )
}

export function Rules({ onBack }: RulesProps) {
  return (
    <div className="rules-page">
      <div className="panel-header">
        <button className="btn ghost" onClick={onBack} title="Back to menu">
          ← Back
        </button>
        <Logo small />
      </div>

      <div className="rules-content">
        <h2>How to play</h2>

        <p>
          Trax is played with square tiles carrying a <b>white</b> and a <b>red</b> track. Every
          tile is one of two shapes — two <b>straights</b> that cross, or two <b>curves</b>. You are
          one of the colors; White moves first.
        </p>

        <div className="rules-figures">
          <Figure caption="Crossing straights">
            <MiniBoard width={96} cells={[{ x: 0, y: 0, tile: 'WRWR' }]} />
          </Figure>
          <Figure caption="Two curves">
            <MiniBoard width={96} cells={[{ x: 0, y: 0, tile: 'RRWW' }]} />
          </Figure>
        </div>

        <p>
          Either shape may be turned to face any way before it's placed — a tile isn't stuck in the
          orientation shown above. The crossing-straights tile looks the same after a half-turn, so it
          has two distinct rotations; the two-curves tile has four.
        </p>

        <div className="rules-figures">
          <Figure caption="Straights, rotation A">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'WRWR' }]} />
          </Figure>
          <Figure caption="Straights, rotation B">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'RWRW' }]} />
          </Figure>
        </div>

        <div className="rules-figures">
          <Figure caption="Curves, rotation A">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'RRWW' }]} />
          </Figure>
          <Figure caption="Curves, rotation B">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'WRRW' }]} />
          </Figure>
          <Figure caption="Curves, rotation C">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'WWRR' }]} />
          </Figure>
          <Figure caption="Curves, rotation D">
            <MiniBoard width={90} cells={[{ x: 0, y: 0, tile: 'RWWR' }]} />
          </Figure>
        </div>

        <p>
          On your turn, place one tile — in whichever rotation you need — next to the existing tiles.
          Every pair of touching edges must match colors. Tap an empty space in-game to bring up a
          picker showing every rotation that fits there — even when there's only one.
        </p>

        <div className="rules-figures">
          <Figure caption="Edges match" tone="ok">
            <MiniBoard width={150} cells={[{ x: 0, y: 0, tile: 'WRWR' }, { x: 1, y: 0, tile: 'WRWR' }]} />
          </Figure>
          <Figure caption="Edges clash — not allowed" tone="bad">
            <MiniBoard width={150} cells={[{ x: 0, y: 0, tile: 'WRWR' }, { x: 1, y: 0, tile: 'RWRW' }]} />
          </Figure>
        </div>

        <p>
          If a placement leaves an empty space with two or more same-colored track ends leading into
          it, that space is filled automatically — a <i>forced play</i>.
        </p>

        <div className="rules-figures">
          <Figure caption="Two red ends meet an empty space">
            <MiniBoard
              width={150}
              cells={[{ x: 0, y: 0, tile: 'WRWR' }, { x: 1, y: 1, tile: 'RWRW' }]}
              empty={[{ x: 1, y: 0 }]}
            />
          </Figure>
          <span className="rules-arrow" aria-hidden>
            →
          </span>
          <Figure caption="It fills in on its own">
            <MiniBoard
              width={150}
              cells={[
                { x: 0, y: 0, tile: 'WRWR' },
                { x: 1, y: 1, tile: 'RWRW' },
                { x: 1, y: 0, tile: 'WWRR', forced: true },
              ]}
            />
          </Figure>
        </div>

        <p>
          One move can grow the position by several tiles as forced plays cascade: a forced fill
          can leave a new empty space with two matching ends of its own — filling{' '}
          <i>that</i> is forced too, and so on down the chain.
        </p>

        <div className="rules-figures">
          <Figure caption="One move, two empty spaces">
            <MiniBoard
              width={210}
              cells={[
                { x: 0, y: 0, tile: 'WRWR' },
                { x: 1, y: 1, tile: 'RWRW' },
                { x: 2, y: 1, tile: 'WRRW' },
              ]}
              empty={[{ x: 1, y: 0 }, { x: 2, y: 0 }]}
            />
          </Figure>
          <span className="rules-arrow" aria-hidden>
            →
          </span>
          <Figure caption="Both fill in, one after the other">
            <MiniBoard
              width={210}
              cells={[
                { x: 0, y: 0, tile: 'WRWR' },
                { x: 1, y: 1, tile: 'RWRW' },
                { x: 2, y: 1, tile: 'WRRW' },
                { x: 1, y: 0, tile: 'WWRR', forced: true },
                { x: 2, y: 0, tile: 'RRWW', forced: true },
              ]}
            />
          </Figure>
        </div>

        <p>
          You win by making a <b>loop</b> of your color, or a <b>line</b> of your color that connects
          opposite edges of the position across at least 8 rows or columns.
        </p>

        <div className="rules-figures">
          <Figure caption="A closed loop wins">
            <MiniBoard
              width={150}
              highlight="R"
              cells={[
                { x: 0, y: 0, tile: 'WRRW' },
                { x: 1, y: 0, tile: 'WWRR' },
                { x: 0, y: 1, tile: 'RRWW' },
                { x: 1, y: 1, tile: 'RWWR' },
              ]}
            />
          </Figure>
        </div>

        <div className="rules-figures">
          <Figure caption="A straight line across 8+ wins">
            <MiniBoard
              width={480}
              highlight="R"
              cells={[0, 1, 2, 3, 4, 5, 6, 7].map((x) => ({ x, y: 0, tile: 'WRWR' as TileKind }))}
            />
          </Figure>
        </div>

        <p>
          The line doesn't have to be straight — it just needs to connect the two opposite edges,
          however it winds along the way.
        </p>

        <div className="rules-figures">
          <Figure caption="A winding line across 8+ also wins">
            <MiniBoard
              width={480}
              highlight="R"
              cells={[
                { x: 0, y: 0, tile: 'WRWR' },
                { x: 1, y: 0, tile: 'WRWR' },
                { x: 2, y: 0, tile: 'WRWR' },
                { x: 3, y: 0, tile: 'WWRR' },
                { x: 3, y: 1, tile: 'RRWW' },
                { x: 4, y: 1, tile: 'WRWR' },
                { x: 5, y: 1, tile: 'WRWR' },
                { x: 6, y: 1, tile: 'WRWR' },
                { x: 7, y: 1, tile: 'WRWR' },
              ]}
            />
          </Figure>
        </div>

        <p>
          Careful: if your move completes your <b>opponent's</b> loop or line, they win. If it
          completes both colors at once, you win.
        </p>
      </div>
    </div>
  )
}
