import { useEffect, useRef } from 'react'
import { encodeMoves } from '../game/transcript'
import type { MoveRecord } from '../game/types'
import { useCopyButton } from '../hooks/useCopyButton'

export interface MoveListProps {
  history: MoveRecord[]
  /** Ply currently shown on the board (0 = before the first move). */
  currentPly: number
  onSelectPly: (ply: number) => void
}

export function MoveList({ history, currentPly, onSelectPly }: MoveListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    const target = list?.querySelector('.move-cell.current') ?? list?.lastElementChild
    target?.scrollIntoView({ block: 'nearest' })
  }, [history.length, currentPly])

  const transcript = encodeMoves(history)
  const copy = useCopyButton('Copy', 'Copied')

  const rows: Array<{ n: number; white?: MoveRecord; red?: MoveRecord }> = []
  history.forEach((rec, i) => {
    if (i % 2 === 0) rows.push({ n: i / 2 + 1, white: rec })
    else rows[rows.length - 1].red = rec
  })

  const cell = (rec: MoveRecord | undefined, ply: number) =>
    rec ? (
      <button
        className={`move-cell ${ply === currentPly ? 'current' : ''}`}
        onClick={() => onSelectPly(ply)}
      >
        {rec.notation}
      </button>
    ) : (
      <span className="move-cell" />
    )

  return (
    <div className="transcript">
      <div className="transcript-head">
        <span className="transcript-label">Moves</span>
        <button
          className={`transcript-copy ${copy.label === 'Copied' ? 'copied' : ''}`}
          onClick={() => copy.click(transcript)}
          disabled={history.length === 0}
          title="Copy this line's moves as standard Trax notation"
        >
          <span className="transcript-copy-icon">{copy.label === 'Copied' ? '✓' : '⧉'}</span>
          {copy.label}
        </button>
      </div>
      <div className="move-list" ref={listRef}>
        {rows.length === 0 && <div className="move-list-empty">No moves yet</div>}
        {rows.map((r) => (
          <div className="move-row" key={r.n}>
            <span className="move-num">{r.n}.</span>
            {cell(r.white, r.n * 2 - 1)}
            {cell(r.red, r.n * 2)}
          </div>
        ))}
      </div>
    </div>
  )
}
