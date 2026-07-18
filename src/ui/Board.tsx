import { useEffect, useMemo, useRef, useState } from 'react'
import { bounds, key, parseKey } from '../game/board'
import type { Board as BoardMap, Coord, Move, MoveRecord, TileKind, WinPath } from '../game/types'
import { TILE, TileGfx } from './Tile'
import { TilePicker } from './TilePicker'

interface View {
  x: number
  y: number
  k: number
}

export interface BoardProps {
  board: BoardMap
  lastMove: MoveRecord | null
  winPaths: WinPath[]
  /** Empty cells the current player may play in, with their legal tiles. */
  legalCells: Map<string, TileKind[]>
  selected: Coord | null
  onSelectCell: (c: Coord | null) => void
  onPlay: (m: Move) => void
  /** Keyboard-focused legal cell, if any (see useKeyboardPlay). */
  cursor?: Coord | null
  /** Tile highlighted by the keyboard within the open picker. */
  pickerIndex?: number
}

export function BoardView({
  board,
  lastMove,
  winPaths,
  legalCells,
  selected,
  onSelectCell,
  onPlay,
  cursor,
  pickerIndex,
}: BoardProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const autoFit = useRef(true)
  const movedRef = useRef(false)
  const pointers = useRef(new Map<number, { x: number; y: number }>())

  const fitView = () => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const b = bounds(board)
    const pad = 1.6 * TILE
    const minX = (b ? b.minX * TILE : 0) - pad
    const minY = (b ? b.minY * TILE : 0) - pad
    const w = (b ? b.width * TILE : TILE) + 2 * pad
    const h = (b ? b.height * TILE : TILE) + 2 * pad
    const k = Math.min(rect.width / w, rect.height / h, 0.85)
    setView({
      x: rect.width / 2 - (minX + w / 2) * k,
      y: rect.height / 2 - (minY + h / 2) * k,
      k,
    })
  }

  // Keep the whole position in view until the user pans or zooms manually.
  useEffect(() => {
    if (autoFit.current) fitView()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      autoFit.current = false
      const rect = svg.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setView((v) => {
        const k = Math.min(2.5, Math.max(0.06, v.k * Math.exp(-e.deltaY * 0.0012)))
        return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) movedRef.current = false
    // Capturing immediately would retarget click events away from the cells;
    // a second finger always means pan/pinch, so capture is safe then.
    else e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const cur = { x: e.clientX, y: e.clientY }
    const pts = pointers.current
    if (pts.size === 1) {
      const dx = cur.x - prev.x
      const dy = cur.y - prev.y
      if (movedRef.current || Math.hypot(dx, dy) > 4) {
        if (!movedRef.current) e.currentTarget.setPointerCapture(e.pointerId)
        movedRef.current = true
        autoFit.current = false
        setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
        pts.set(e.pointerId, cur)
      }
    } else if (pts.size === 2) {
      movedRef.current = true
      autoFit.current = false
      const [idA, idB] = [...pts.keys()]
      const other = pts.get(idA === e.pointerId ? idB : idA)!
      const dPrev = Math.hypot(prev.x - other.x, prev.y - other.y)
      const dCur = Math.hypot(cur.x - other.x, cur.y - other.y)
      if (dPrev > 0) {
        const rect = svgRef.current!.getBoundingClientRect()
        const mx = (cur.x + other.x) / 2 - rect.left
        const my = (cur.y + other.y) / 2 - rect.top
        setView((v) => {
          const k = Math.min(2.5, Math.max(0.06, (v.k * dCur) / dPrev))
          return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
        })
      }
      pts.set(e.pointerId, cur)
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0 && !movedRef.current && e.target === e.currentTarget) {
      onSelectCell(null)
    }
  }

  const winColorByCell = useMemo(() => {
    const m = new Map<string, WinPath['color']>()
    for (const p of winPaths) for (const c of p.cells) m.set(c, p.color)
    return m
  }, [winPaths])

  const placedInfo = useMemo(() => {
    const m = new Map<string, { order: number; forced: boolean }>()
    lastMove?.placed.forEach((p, i) => m.set(key(p.x, p.y), { order: i, forced: p.forced }))
    return m
  }, [lastMove])

  const selectedTiles = selected ? (legalCells.get(key(selected.x, selected.y)) ?? []) : []

  return (
    <svg
      ref={svgRef}
      className="board"
      tabIndex={0}
      role="application"
      aria-label="Trax board. Tab or arrow keys to move between legal spaces, Enter to place a tile."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
        {[...board.entries()].map(([k, tile]) => {
          const { x, y } = parseKey(k)
          const placed = placedInfo.get(k)
          return (
            <g key={k} data-tile-at={k} transform={`translate(${x * TILE} ${y * TILE})`}>
              <g
                className={placed ? 'tile-pop' : undefined}
                style={placed ? { animationDelay: `${placed.order * 0.13}s` } : undefined}
              >
                <TileGfx tile={tile} highlight={winColorByCell.get(k)} />
              </g>
              {placed && (
                <rect
                  x={2}
                  y={2}
                  width={TILE - 4}
                  height={TILE - 4}
                  rx={9}
                  className={placed.forced ? 'last-move forced' : 'last-move'}
                />
              )}
            </g>
          )
        })}
        {[...legalCells.keys()].map((k) => {
          const { x, y } = parseKey(k)
          const isSel = selected && key(selected.x, selected.y) === k
          return (
            <rect
              key={k}
              data-cell={k}
              x={x * TILE + 6}
              y={y * TILE + 6}
              width={TILE - 12}
              height={TILE - 12}
              rx={10}
              className={isSel ? 'legal-cell selected' : 'legal-cell'}
              onClick={() => {
                if (movedRef.current) return
                onSelectCell(isSel ? null : { x, y })
              }}
            />
          )
        })}
        {cursor && (
          <rect
            data-cursor={key(cursor.x, cursor.y)}
            x={cursor.x * TILE + 3}
            y={cursor.y * TILE + 3}
            width={TILE - 6}
            height={TILE - 6}
            rx={11}
            className="cursor-cell"
          />
        )}
        {selected && selectedTiles.length > 0 && (
          <TilePicker
            cell={selected}
            tiles={selectedTiles}
            activeIndex={pickerIndex}
            onPick={(tile) => {
              onPlay({ ...selected, tile })
              onSelectCell(null)
            }}
          />
        )}
      </g>
      <g className="board-tools">
        <g
          transform="translate(16 16)"
          className="recenter-btn"
          onClick={() => {
            autoFit.current = true
            fitView()
          }}
        >
          <rect width={36} height={36} rx={8} />
          <circle cx={18} cy={18} r={7} fill="none" strokeWidth={2} />
          <path d="M18 5 v6 M18 25 v6 M5 18 h6 M25 18 h6" strokeWidth={2} />
        </g>
      </g>
    </svg>
  )
}
