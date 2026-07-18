import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { key } from '../game/board'
import { boardAtPly } from '../game/engine'
import { legalMoves } from '../game/moves'
import { encodeMoves } from '../game/transcript'
import type { Color, Coord, GameState, Move, TileKind } from '../game/types'
import { BoardView } from './Board'
import { HistoryNav } from './HistoryNav'
import { Logo } from './Logo'
import { MoveList } from './MoveList'
import { resultReasonText } from './resultText'

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
  /** Open the explorer seeded with this game's moves, at the ply being viewed. */
  onExplore?: (moves: string, ply: number) => void
  /** Shown on the game-over card. */
  endAction?: { label: string; run: () => void; note?: string }
}

export function GameScreen(props: GameScreenProps) {
  const { state, perspective, names, banner, canAct, onPlay, onExit, onResign, onUndo, onExplore, endAction } =
    props
  const [selected, setSelected] = useState<Coord | null>(null)
  // History review: which ply the board shows; null means follow the live game.
  const [viewPly, setViewPly] = useState<number | null>(null)

  const plies = state.history.length
  const atLive = viewPly === null || viewPly >= plies
  const ply = atLive ? plies : viewPly
  const goTo = (p: number) => setViewPly(p >= plies ? null : Math.max(0, p))

  const legalCells = useMemo(() => {
    const m = new Map<string, TileKind[]>()
    if (!canAct || state.result || !atLive) return m
    for (const mv of legalMoves(state)) {
      const k = key(mv.x, mv.y)
      const list = m.get(k)
      if (list) list.push(mv.tile)
      else m.set(k, [mv.tile])
    }
    return m
  }, [state, canAct, atLive])

  const displayBoard = useMemo(
    () => (atLive ? state.board : boardAtPly(state.history, ply)),
    [state, atLive, ply],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goTo(ply - 1)
      else if (e.key === 'ArrowRight') goTo(ply + 1)
      else if (e.key === 'Home') goTo(0)
      else if (e.key === 'End') setViewPly(null)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const play = (m: Move) => {
    setSelected(null)
    onPlay(m)
  }

  const result = state.result
  const lastMove = ply > 0 ? state.history[ply - 1] : null

  return (
    <div className="game-screen">
      <aside className="side-panel">
        <div className="panel-header">
          <button className="btn ghost" onClick={onExit} title="Leave game">
            ← Leave
          </button>
          <Logo small />
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
            <div className="result-sub">{resultReasonText(result.reason)}</div>
            {endAction && (
              <button className="btn primary" onClick={endAction.run}>
                {endAction.label}
              </button>
            )}
            {endAction?.note && <div className="result-note">{endAction.note}</div>}
          </div>
        )}

        <MoveList history={state.history} currentPly={ply} onSelectPly={goTo} />

        <HistoryNav
          ply={ply}
          plies={plies}
          onFirst={() => goTo(0)}
          onBack={() => goTo(ply - 1)}
          onForward={() => goTo(ply + 1)}
          onLast={() => setViewPly(null)}
        />

        <div className="panel-actions">
          {onUndo && (
            <button className="btn" onClick={onUndo} disabled={state.history.length === 0 && !result}>
              Undo
            </button>
          )}
          {onResign && (
            <button className="btn danger" onClick={onResign} disabled={!!result || state.board.size === 0}>
              Resign
            </button>
          )}
          {onExplore && (
            <button
              className="btn"
              onClick={() => onExplore(encodeMoves(state.history), ply)}
              title="Open this position in the explorer"
            >
              Explore
            </button>
          )}
        </div>
      </aside>

      <main className="board-wrap">
        <BoardView
          board={displayBoard}
          lastMove={lastMove}
          winPaths={atLive ? (result?.paths ?? []) : []}
          legalCells={legalCells}
          selected={selected}
          onSelectCell={setSelected}
          onPlay={play}
        />
        {!atLive && (
          <div className="turn-banner reviewing">
            Viewing move {ply} of {plies} — press ⏭ to return
          </div>
        )}
        {atLive && result && (
          <div className="turn-banner win-banner">
            {COLOR_NAME[result.winner]} wins — {resultReasonText(result.reason)}
          </div>
        )}
        {atLive && !result && (
          <div className="turn-banner">
            {canAct
              ? state.board.size === 0
                ? 'Place the first tile in the centre'
                : 'Your move — pick a highlighted space'
              : `Waiting for ${names[state.turn]}…`}
          </div>
        )}
      </main>
    </div>
  )
}
