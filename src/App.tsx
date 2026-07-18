import { useState } from 'react'
import { useLocalGame } from './hooks/useLocalGame'
import type { Role } from './hooks/useP2PGame'
import { makeRoomCode, normalizeCode } from './net/room'
import { AIGame } from './ui/AIGame'
import { Explorer } from './ui/Explorer'
import { GameScreen } from './ui/GameScreen'
import { Home } from './ui/Home'
import { P2PGame } from './ui/P2PGame'
import { Rules } from './ui/Rules'
import type { Color } from './game/types'

type Screen =
  | { s: 'home' }
  | { s: 'local' }
  | { s: 'ai'; human: Color }
  | { s: 'rules' }
  | { s: 'p2p'; code: string; role: Role }
  | { s: 'explore'; moves: string | null; ply: number | null }

function initialScreen(): Screen {
  const room = /^#room=([A-Za-z0-9]+)/.exec(location.hash)
  if (room) return { s: 'p2p', code: normalizeCode(room[1]), role: 'guest' }
  const explore = /^#explore(?:=([^&]*))?(?:&ply=(\d+))?/.exec(location.hash)
  if (explore) {
    return {
      s: 'explore',
      moves: explore[1] ? decodeURIComponent(explore[1]) : null,
      ply: explore[2] ? parseInt(explore[2], 10) : null,
    }
  }
  return { s: 'home' }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen)

  const goHome = () => {
    if (location.hash) history.replaceState(null, '', location.pathname)
    setScreen({ s: 'home' })
  }

  const onExplore = (moves: string, ply: number) => {
    const hash = moves ? `#explore=${encodeURIComponent(moves)}&ply=${ply}` : '#explore'
    window.open(`${location.pathname}${hash}`, '_blank', 'noopener')
  }

  switch (screen.s) {
    case 'home':
      return (
        <Home
          onLocal={() => setScreen({ s: 'local' })}
          onComputer={(human) => setScreen({ s: 'ai', human })}
          onCreate={() => setScreen({ s: 'p2p', code: makeRoomCode(), role: 'host' })}
          onJoin={(code) => setScreen({ s: 'p2p', code, role: 'guest' })}
          onRules={() => setScreen({ s: 'rules' })}
          onExplore={() => setScreen({ s: 'explore', moves: null, ply: null })}
        />
      )
    case 'local':
      return <LocalGame onExit={goHome} onExplore={onExplore} />
    case 'ai':
      return <AIGame key={screen.human} humanColor={screen.human} onExit={goHome} onExplore={onExplore} />
    case 'rules':
      return <Rules onBack={goHome} />
    case 'p2p':
      return (
        <P2PGame key={screen.code} code={screen.code} role={screen.role} onExit={goHome} onExplore={onExplore} />
      )
    case 'explore':
      return <Explorer init={{ moves: screen.moves, ply: screen.ply }} onExit={goHome} />
  }
}

function LocalGame({ onExit, onExplore }: { onExit: () => void; onExplore: (moves: string, ply: number) => void }) {
  const g = useLocalGame()
  return (
    <GameScreen
      state={g.state}
      perspective={null}
      names={{ W: 'White', R: 'Red' }}
      canAct={true}
      onPlay={g.play}
      onUndo={g.undo}
      onResign={g.resign}
      onExit={onExit}
      onExplore={onExplore}
      endAction={{ label: 'New game', run: g.reset }}
    />
  )
}
