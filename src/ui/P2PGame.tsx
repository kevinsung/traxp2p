import { useState } from 'react'
import { copyText } from '../net/clipboard'
import { useP2PGame, type Role } from '../hooks/useP2PGame'
import { GameScreen } from './GameScreen'
import { Logo } from './Logo'

export interface P2PGameProps {
  code: string
  role: Role
  onExit: () => void
  onExplore?: (moves: string, ply: number) => void
}

export function P2PGame({ code, role, onExit, onExplore }: P2PGameProps) {
  const g = useP2PGame(code, role)
  const [copied, setCopied] = useState(false)

  if (g.status === 'waiting') {
    const link = `${location.origin}${location.pathname}#room=${code}`
    return (
      <div className="lobby">
        <Logo />
        {role === 'host' ? (
          <>
            <p>Share this room code with your opponent:</p>
            <div className="room-code">{code}</div>
            <button
              className="btn primary"
              onClick={async () => {
                const ok = await copyText(link)
                setCopied(ok)
                if (ok) setTimeout(() => setCopied(false), 2000)
              }}
            >
              {copied ? 'Link copied!' : 'Copy invite link'}
            </button>
            <p className="invite-link">
              or send this link:
              <br />
              <code>{link}</code>
            </p>
            <p className="lobby-hint">
              Waiting for an opponent to join<span className="dots" />
            </p>
          </>
        ) : (
          <p className="lobby-hint">
            Joining room <b>{code}</b>
            <span className="dots" />
          </p>
        )}
        <button className="btn ghost" onClick={onExit}>
          ← Back
        </button>
      </div>
    )
  }

  if (g.status === 'full' || g.status === 'error' || g.status === 'desync') {
    const msg =
      g.status === 'full'
        ? 'That room already has two players.'
        : g.status === 'desync'
          ? `The game went out of sync: ${g.error ?? 'unknown reason'}.`
          : `Connection error: ${g.error ?? 'unknown'}.`
    return (
      <div className="lobby">
        <Logo />
        <p className="lobby-error">{msg}</p>
        <button className="btn ghost" onClick={onExit}>
          ← Back to menu
        </button>
      </div>
    )
  }

  const endAction =
    g.rematch === 'none'
      ? { label: 'Offer rematch', run: g.offerRematch }
      : g.rematch === 'offered'
        ? { label: 'Rematch offered…', run: () => {}, note: 'Waiting for your opponent to accept' }
        : { label: 'Accept rematch', run: g.acceptRematch, note: 'Your opponent wants a rematch' }

  return (
    <GameScreen
      state={g.state}
      perspective={g.myColor}
      names={{ W: 'White', R: 'Red' }}
      canAct={g.status === 'playing' && g.myColor === g.state.turn}
      banner={
        g.status === 'peer-left' ? (
          <div className="net-banner">
            Opponent disconnected — they can rejoin with code <b>{code}</b>
          </div>
        ) : null
      }
      onPlay={g.play}
      onResign={g.resign}
      onExit={onExit}
      onExplore={onExplore}
      endAction={g.state.result ? endAction : undefined}
    />
  )
}
