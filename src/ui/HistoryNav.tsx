export interface HistoryNavProps {
  /** Ply currently viewed (0 = before the first move). */
  ply: number
  /** Total plies in the line. */
  plies: number
  onFirst: () => void
  onBack: () => void
  onForward: () => void
  onLast: () => void
}

/** The ⏮ ◀ n/n ▶ ⏭ row shared by the game screen and the explorer. */
export function HistoryNav({ ply, plies, onFirst, onBack, onForward, onLast }: HistoryNavProps) {
  const atEnd = ply >= plies
  return (
    <div className="history-nav">
      <button className="btn" onClick={onFirst} disabled={ply === 0} title="First position (Home)">
        ⏮
      </button>
      <button className="btn" onClick={onBack} disabled={ply === 0} title="Back (←)">
        ◀
      </button>
      <span className="history-pos">
        {ply} / {plies}
      </span>
      <button className="btn" onClick={onForward} disabled={atEnd} title="Forward (→)">
        ▶
      </button>
      <button className="btn" onClick={onLast} disabled={atEnd} title="Last position (End)">
        ⏭
      </button>
    </div>
  )
}
