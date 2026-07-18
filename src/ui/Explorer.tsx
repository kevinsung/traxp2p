import { useEffect, useMemo, useState } from 'react'
import { key } from '../game/board'
import { legalMoves } from '../game/moves'
import { encodeMoves, replayTranscript } from '../game/transcript'
import type { Coord, Move, TileKind } from '../game/types'
import { useCopyButton } from '../hooks/useCopyButton'
import { useExplorer, type ExplorerInit } from '../hooks/useExplorer'
import { useKeyboardPlay } from '../hooks/useKeyboardPlay'
import { BoardView } from './Board'
import { HistoryNav } from './HistoryNav'
import { Logo } from './Logo'
import { MoveList } from './MoveList'
import { resultReasonText } from './resultText'

export interface ExplorerProps {
  init?: ExplorerInit
  onExit: () => void
}

function hashFor(moves: string, ply: number): string {
  return moves ? `#explore=${encodeURIComponent(moves)}&ply=${ply}` : '#explore'
}

export function Explorer({ init, onExit }: ExplorerProps) {
  const ex = useExplorer(init)
  const [selected, setSelected] = useState<Coord | null>(null)
  const shareLinkBtn = useCopyButton('Share link', 'Link copied!')
  const [pasted, setPasted] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  const fullHistory = ex.line[ex.line.length - 1].history
  const transcript = encodeMoves(fullHistory)
  const plies = ex.plies
  const ply = ex.cursor
  const state = ex.state
  const result = state.result

  // Keep the URL in sync with the current line + viewed ply so it's always
  // shareable via the address bar, not just the Share button.
  useEffect(() => {
    history.replaceState(null, '', location.pathname + hashFor(transcript, ply))
  }, [transcript, ply])

  const aiBusy = ex.thinking || ex.autoPlay

  const legalCells = useMemo(() => {
    const m = new Map<string, TileKind[]>()
    if (result || aiBusy) return m
    for (const mv of legalMoves(state)) {
      const k = key(mv.x, mv.y)
      const list = m.get(k)
      if (list) list.push(mv.tile)
      else m.set(k, [mv.tile])
    }
    return m
  }, [state, result, aiBusy])

  const play = (m: Move) => {
    setSelected(null)
    ex.play(m)
  }

  const { cursor, pickerIndex, announce } = useKeyboardPlay({
    board: state.board,
    legalCells,
    enabled: !result && !aiBusy,
    atLive: ply >= plies,
    selected,
    setSelected,
    onPlay: play,
    history: { back: ex.back, forward: ex.forward, first: ex.first, last: ex.last },
  })

  const shareLink = () => `${location.origin}${location.pathname}${hashFor(transcript, ply)}`

  const doLoad = () => {
    const text = pasted.trim()
    if (!text) return
    // Accept a pasted share URL as well as bare notation.
    const m = /#explore(?:=([^&]*))?/.exec(text)
    const notation = m ? (m[1] ? decodeURIComponent(m[1]) : '') : text
    const r = replayTranscript(notation)
    if (!r.ok) {
      setLoadError(r.error)
      return
    }
    setLoadError(null)
    setPasted('')
    ex.load(r.line)
  }

  const lastMove = ply > 0 ? fullHistory[ply - 1] : null

  return (
    <div className="game-screen">
      <aside className="side-panel">
        <div className="panel-header">
          <button className="btn ghost" onClick={onExit} title="Leave explorer">
            ← Leave
          </button>
          <Logo small />
        </div>

        <div className="home-card-title">Explorer</div>

        {result && (
          <div className={`result-card winner-${result.winner}`}>
            <div className="result-title">
              {result.winner === 'W' ? 'White' : 'Red'} wins!
            </div>
            <div className="result-sub">{resultReasonText(result.reason)}</div>
          </div>
        )}

        <MoveList history={fullHistory} currentPly={ply} onSelectPly={ex.goTo} />

        <HistoryNav ply={ply} plies={plies} onFirst={ex.first} onBack={ex.back} onForward={ex.forward} onLast={ex.last} />

        <div className="panel-actions">
          <button className="btn" onClick={ex.reset} disabled={ex.line.length === 1}>
            Reset
          </button>
          <button className="btn" onClick={() => shareLinkBtn.click(shareLink())}>
            {shareLinkBtn.label}
          </button>
        </div>

        <div className="panel-actions">
          <button
            className="btn"
            onClick={ex.generateMove}
            disabled={!!result || aiBusy}
            title="Have the computer generate a move for the side to play"
          >
            Generate move
          </button>
          <button
            className="btn"
            onClick={ex.toggleAutoPlay}
            disabled={!!result && !ex.autoPlay}
            title="Have the computer play both sides from here"
          >
            {ex.autoPlay ? 'Stop auto-play' : 'Auto-play'}
          </button>
        </div>

        <div className="join-card">
          <span className="home-card-title">Load a position</span>
          <div className="join-row">
            <input
              className="freeform"
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value)
                setLoadError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doLoad()
              }}
              placeholder="Paste a transcript"
              aria-label="Transcript or share link"
            />
            <button className="btn primary" onClick={doLoad} disabled={!pasted.trim()}>
              Load
            </button>
          </div>
          {loadError && <div className="lobby-error">{loadError}</div>}
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
          cursor={cursor}
          pickerIndex={pickerIndex}
        />
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
        {aiBusy && (
          <div className="turn-banner reviewing">
            Computer is thinking<span className="dots" />
          </div>
        )}
        {result && !aiBusy && (
          <div className="turn-banner win-banner">
            {result.winner === 'W' ? 'White' : 'Red'} wins — {resultReasonText(result.reason)}
          </div>
        )}
        {!result && !aiBusy && (
          <div className="turn-banner">
            {state.board.size === 0 ? 'Place the first tile anywhere' : 'Pick a highlighted space to place a tile'}
          </div>
        )}
      </main>
    </div>
  )
}
