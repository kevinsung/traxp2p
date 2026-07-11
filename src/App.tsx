import { useState } from 'react'
import { useLocalGame } from './hooks/useLocalGame'
import type { Role } from './hooks/useP2PGame'
import { makeRoomCode, normalizeCode } from './net/room'
import { GameScreen } from './ui/GameScreen'
import { Home } from './ui/Home'
import { P2PGame } from './ui/P2PGame'
import { Rules } from './ui/Rules'

type Screen = { s: 'home' } | { s: 'local' } | { s: 'rules' } | { s: 'p2p'; code: string; role: Role }

function initialScreen(): Screen {
  const m = /^#room=([A-Za-z0-9]+)/.exec(location.hash)
  if (m) return { s: 'p2p', code: normalizeCode(m[1]), role: 'guest' }
  return { s: 'home' }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(initialScreen)

  const goHome = () => {
    if (location.hash) history.replaceState(null, '', location.pathname)
    setScreen({ s: 'home' })
  }

  switch (screen.s) {
    case 'home':
      return (
        <Home
          onLocal={() => setScreen({ s: 'local' })}
          onCreate={() => setScreen({ s: 'p2p', code: makeRoomCode(), role: 'host' })}
          onJoin={(code) => setScreen({ s: 'p2p', code, role: 'guest' })}
          onRules={() => setScreen({ s: 'rules' })}
        />
      )
    case 'local':
      return <LocalGame onExit={goHome} />
    case 'rules':
      return <Rules onBack={goHome} />
    case 'p2p':
      return <P2PGame key={screen.code} code={screen.code} role={screen.role} onExit={goHome} />
  }
}

function LocalGame({ onExit }: { onExit: () => void }) {
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
      endAction={{ label: 'New game', run: g.reset }}
    />
  )
}
