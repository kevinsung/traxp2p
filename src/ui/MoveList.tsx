import { useEffect, useRef } from 'react'
import type { MoveRecord } from '../game/types'

export function MoveList({ history }: { history: MoveRecord[] }) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [history.length])

  const rows: Array<{ n: number; white?: MoveRecord; red?: MoveRecord }> = []
  history.forEach((rec, i) => {
    if (i % 2 === 0) rows.push({ n: i / 2 + 1, white: rec })
    else rows[rows.length - 1].red = rec
  })

  return (
    <div className="move-list">
      {rows.length === 0 && <div className="move-list-empty">No moves yet</div>}
      {rows.map((r) => (
        <div className="move-row" key={r.n}>
          <span className="move-num">{r.n}.</span>
          <span className="move-cell">{r.white?.notation}</span>
          <span className="move-cell">{r.red?.notation ?? ''}</span>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
