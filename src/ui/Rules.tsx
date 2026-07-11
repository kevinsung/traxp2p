export interface RulesProps {
  onBack: () => void
}

export function Rules({ onBack }: RulesProps) {
  return (
    <div className="rules-page">
      <div className="panel-header">
        <button className="btn ghost" onClick={onBack} title="Back to menu">
          ← Back
        </button>
        <h1 className="logo small">TRAX</h1>
      </div>

      <div className="rules-content">
        <h2>How to play</h2>
        <p>
          Trax is played with square tiles carrying a <b>white</b> and a <b>red</b> track — two
          straights that cross, or two curves. You are one of the colors; White moves first.
        </p>
        <p>
          On your turn, place one tile next to the existing tiles. Touching edges must match
          colors. If a placement leaves an empty space with two or more same-colored track ends
          leading into it, that space is filled automatically (a <i>forced play</i>) — one move
          can grow the position by several tiles.
        </p>
        <p>
          You win by making a <b>loop</b> of your color, or a <b>line</b> of your color that
          connects opposite edges of the position across at least 8 rows or columns. Careful:
          if your move completes your opponent's loop or line, they win. If it completes both,
          you win.
        </p>
      </div>
    </div>
  )
}
