import { useAIGame } from '../hooks/useAIGame'
import { GameScreen } from './GameScreen'
import type { Color } from '../game/types'

export interface AIGameProps {
  humanColor: Color
  onExit: () => void
  onExplore?: (moves: string, ply: number) => void
}

export function AIGame({ humanColor, onExit, onExplore }: AIGameProps) {
  const g = useAIGame(humanColor)
  const names: Record<Color, string> =
    humanColor === 'W' ? { W: 'You', R: 'Computer' } : { W: 'Computer', R: 'You' }

  return (
    <GameScreen
      state={g.state}
      perspective={humanColor}
      names={names}
      canAct={!g.state.result && g.state.turn === humanColor && !g.thinking}
      notice={
        g.thinking ? (
          <>
            Computer is thinking<span className="dots" />
          </>
        ) : null
      }
      onPlay={g.play}
      onUndo={g.undo}
      onResign={g.resign}
      onExit={onExit}
      onExplore={onExplore}
      endAction={{ label: 'Rematch', run: g.reset }}
    />
  )
}
