import { useMemo, useState, type ReactNode } from 'react'
import { key } from '../game/board'
import { legalMoves } from '../game/moves'
import type { Color, Coord, GameState, Move, TileKind } from '../game/types'
import { BoardView } from './Board'
import { MoveList } from './MoveList'

const COLOR_NAME: Record<Color, string> = { W: 'White', R: 'Red' }

export interface GameScreenProps {
  state: GameState
  /** Which color this client controls; null means hotseat (both). */
  perspective: Color | null
  names: Record<Color, string>
  /** Extra banner content (connection status etc.). */
  banner?: ReactNode
  canAct: boolean
  onPlay: (m: Move) => void
  onExit: () => void
  onResign?: () => void
  onUndo?: () => void
  /** Shown on the game-over card. */
  endAction?: { label: string; run: () => void; note?: string }
}

export function GameScreen(props: GameScreenProps) {
  const { state, perspective, names, banner, canAct, onPlay, onExit, onResign, onUndo, endAction } = props
  const [selected, setSelected] = useState<Coord | null>(null)

  const legalCells = useMemo(() => {
    const m = new Map<string, TileKind[]>()
    if (!canAct || state.result) return m
    for (const mv of legalMoves(state)) {
      const k = key(mv.x, mv.y)
      const list = m.get(k)
      if (list) list.push(mv.tile)
      else m.set(k, [mv.tile])
    }
    return m
  }, [state, canAct])

  const play = (m: Move) => {
    setSelected(null)
    onPlay(m)
  }

  const result = state.result
  const lastMove = state.history.at(-1) ?? null

  return (
    <div className="game-screen">
      <aside className="side-panel">
        <div className="panel-header">
          <button className="btn ghost" onClick={onExit} title="Leave game">
            ← Leave
          </button>
          <h1 className="logo small">TRAX</h1>
        </div>

        <div className="players">
          {(['W', 'R'] as const).map((c) => (
            <div key={c} className={`player-chip ${c === state.turn && !result ? 'active' : ''}`}>
              <span className={`swatch swatch-${c}`} />
              <span className="player-name">
                {names[c]}
                {perspective === c && <span className="you-tag"> (you)</span>}
              </span>
              {c === state.turn && !result && <span className="turn-dot" />}
            </div>
          ))}
        </div>

        {banner}

        {result && (
          <div className={`result-card winner-${result.winner}`}>
            <div className="result-title">{COLOR_NAME[result.winner]} wins!</div>
            <div className="result-sub">
              {result.reason === 'resignation'
                ? 'by resignation'
                : result.reason === 'loop'
                  ? 'by completing a loop'
                  : 'by completing a line across 8 rows'}
            </div>
            {endAction && (
              <button className="btn primary" onClick={endAction.run}>
                {endAction.label}
              </button>
            )}
            {endAction?.note && <div className="result-note">{endAction.note}</div>}
          </div>
        )}

        <MoveList history={state.history} />

        <div className="panel-actions">
          {onUndo && (
            <button className="btn" onClick={onUndo} disabled={state.history.length === 0 && !result}>
              Undo
            </button>
          )}
          {onResign && !result && (
            <button className="btn danger" onClick={onResign} disabled={state.board.size === 0}>
              Resign
            </button>
          )}
        </div>
      </aside>

      <main className="board-wrap">
        <BoardView
          board={state.board}
          lastMove={lastMove}
          winPaths={result?.paths ?? []}
          legalCells={legalCells}
          selected={selected}
          onSelectCell={setSelected}
          onPlay={play}
        />
        {!result && (
          <div className="turn-banner">
            {canAct
              ? state.board.size === 0
                ? 'Place the first tile in the centre'
                : 'Your move — pick a highlighted space'
              : `Waiting for ${COLOR_NAME[state.turn]}…`}
          </div>
        )}
      </main>
    </div>
  )
}
