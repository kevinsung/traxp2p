import { useEffect, useState } from 'react'
import { key, parseKey } from '../game/board'
import { encodeMove } from '../game/notation'
import type { Board, Coord, Dir, Move, TileKind } from '../game/types'

export interface HistoryNavActions {
  back(): void
  forward(): void
  first(): void
  last(): void
}

export interface UseKeyboardPlayArgs {
  /** Board the cursor moves over (for building move labels). */
  board: Board
  /** Empty cells the current player may play in, with their legal tiles. */
  legalCells: Map<string, TileKind[]>
  /** Whether this client may act right now (its turn, no pending result). */
  enabled: boolean
  /** Whether the live position (not an earlier ply) is being viewed. */
  atLive: boolean
  selected: Coord | null
  setSelected: (c: Coord | null) => void
  onPlay: (m: Move) => void
  history: HistoryNavActions
}

const DIR_KEYS: Record<string, Dir> = { ArrowUp: 0, ArrowRight: 1, ArrowDown: 2, ArrowLeft: 3 }

/** Legal cells in reading order (top to bottom, left to right). */
function readingOrder(cells: Coord[]): Coord[] {
  return [...cells].sort((a, b) => a.y - b.y || a.x - b.x)
}

/**
 * The legal cell nearest `from` in direction `dir`, favoring cells close to
 * `from`'s row/column over ones merely closer in a straight-line sense — so
 * "down" lands on the cell almost directly below rather than a diagonal one
 * a single step closer.
 */
function nearestInDirection(cells: Coord[], from: Coord, dir: Dir): Coord | null {
  let best: Coord | null = null
  let bestScore = Infinity
  for (const c of cells) {
    if (c.x === from.x && c.y === from.y) continue
    let axisGap: number
    let offGap: number
    if (dir === 0) {
      if (c.y >= from.y) continue
      axisGap = from.y - c.y
      offGap = Math.abs(c.x - from.x)
    } else if (dir === 2) {
      if (c.y <= from.y) continue
      axisGap = c.y - from.y
      offGap = Math.abs(c.x - from.x)
    } else if (dir === 1) {
      if (c.x <= from.x) continue
      axisGap = c.x - from.x
      offGap = Math.abs(c.y - from.y)
    } else {
      if (c.x >= from.x) continue
      axisGap = from.x - c.x
      offGap = Math.abs(c.y - from.y)
    }
    const score = axisGap + 3 * offGap
    if (score < bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

/** Trax column+row label for `cell` (drops the tile symbol `encodeMove` adds). */
function cellLabel(board: Board, cell: Coord, tiles: TileKind[]): string {
  return encodeMove(board, { ...cell, tile: tiles[0] }).slice(0, -1)
}

const isTextInput = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)

/**
 * Keyboard control for the board: a spatial cursor over the legal cells
 * (Tab/arrows to move, Enter to open the tile picker; in the picker,
 * arrows cycle the highlighted tile and Enter or 1-3 places it), plus the
 * history-nav keys (arrows/Home/End) for whenever cursor play isn't active —
 * reviewing an earlier ply, or waiting on the other player.
 */
export function useKeyboardPlay({
  board,
  legalCells,
  enabled,
  atLive,
  selected,
  setSelected,
  onPlay,
  history,
}: UseKeyboardPlayArgs): { cursor: Coord | null; pickerIndex: number; announce: string } {
  const [cursor, setCursor] = useState<Coord | null>(null)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [announce, setAnnounce] = useState('')

  // A fresh legalCells map means the position (or who may act) changed —
  // drop any stale cursor rather than let it point at a now-illegal cell.
  useEffect(() => {
    setCursor(null)
  }, [legalCells, enabled, atLive])

  // Highlight the first tile whenever a new picker opens.
  useEffect(() => {
    setPickerIndex(0)
  }, [selected])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInput(e.target)) return

      if (e.key === 'Home') {
        history.first()
        e.preventDefault()
        return
      }
      if (e.key === 'End') {
        history.last()
        e.preventDefault()
        return
      }

      if (selected) {
        const tiles = legalCells.get(key(selected.x, selected.y)) ?? []
        if (e.key === 'Escape') {
          setSelected(null)
          setAnnounce('Selection cancelled')
          e.preventDefault()
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          setPickerIndex((i) => (i - 1 + tiles.length) % tiles.length)
          e.preventDefault()
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          setPickerIndex((i) => (i + 1) % tiles.length)
          e.preventDefault()
        } else if (e.key === 'Enter' || e.key === ' ') {
          const tile = tiles[pickerIndex]
          if (tile) {
            onPlay({ ...selected, tile })
            e.preventDefault()
          }
        } else if (e.key === '1' || e.key === '2' || e.key === '3') {
          const tile = tiles[Number(e.key) - 1]
          if (tile) {
            onPlay({ ...selected, tile })
            e.preventDefault()
          }
        }
        return
      }

      if (!enabled || !atLive || legalCells.size === 0) {
        if (e.key === 'ArrowLeft') {
          history.back()
          e.preventDefault()
        } else if (e.key === 'ArrowRight') {
          history.forward()
          e.preventDefault()
        }
        return
      }

      const cells = [...legalCells.keys()].map(parseKey)

      if (e.key === 'Tab') {
        e.preventDefault()
        const sorted = readingOrder(cells)
        const idx = cursor ? sorted.findIndex((c) => c.x === cursor.x && c.y === cursor.y) : -1
        const next =
          idx < 0
            ? sorted[0]
            : sorted[(idx + (e.shiftKey ? -1 : 1) + sorted.length) % sorted.length]
        setCursor(next)
        setAnnounce(`Cursor at ${cellLabel(board, next, legalCells.get(key(next.x, next.y))!)}`)
      } else if (e.key in DIR_KEYS) {
        e.preventDefault()
        const next = cursor ? (nearestInDirection(cells, cursor, DIR_KEYS[e.key]) ?? cursor) : readingOrder(cells)[0]
        setCursor(next)
        setAnnounce(`Cursor at ${cellLabel(board, next, legalCells.get(key(next.x, next.y))!)}`)
      } else if ((e.key === 'Enter' || e.key === ' ') && cursor) {
        e.preventDefault()
        const tiles = legalCells.get(key(cursor.x, cursor.y)) ?? []
        setSelected(cursor)
        setAnnounce(
          `Tile picker at ${cellLabel(board, cursor, tiles)} — ${tiles.length} tile${tiles.length === 1 ? '' : 's'}, use arrow keys or 1${tiles.length > 1 ? `-${tiles.length}` : ''} then Enter to place`,
        )
      } else if (e.key === 'Escape' && cursor) {
        setCursor(null)
        setAnnounce('')
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return { cursor, pickerIndex, announce }
}
