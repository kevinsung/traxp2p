import { useAIGame } from '../hooks/useAIGame'
import { GameScreen } from './GameScreen'
import type { Color } from '../game/types'

export interface AIGameProps {
  humanColor: Color
  onExit: () => void
}

export function AIGame({ humanColor, onExit }: AIGameProps) {
  const g = useAIGame(humanColor)
  const names: Record<Color, string> =
    humanColor === 'W' ? { W: 'You', R: 'Computer' } : { W: 'Computer', R: 'You' }

  return (
    <GameScreen
      state={g.state}
      perspective={humanColor}
      names={names}
      canAct={!g.state.result && g.state.turn === humanColor && !g.thinking}
      banner={
        g.thinking ? (
          <div className="net-banner">
            Computer is thinking<span className="dots" />
          </div>
        ) : null
      }
      onPlay={g.play}
      onUndo={g.undo}
      onResign={g.resign}
      onExit={onExit}
      endAction={{ label: 'Rematch', run: g.reset }}
    />
  )
}
