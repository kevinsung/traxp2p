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

  // Mirrors the target-ply computation in useP2PGame's requestUndo: only enabled
  // once the requester has a move of their own on the board to take back.
  const canRequestUndo =
    g.status === 'playing' &&
    g.myColor !== null &&
    g.state.history.length - (g.state.turn === g.myColor ? 2 : 1) >= 0

  const undoBanner =
    g.undo === 'received' ? (
      <>
        <span>Opponent wants to undo the last move.</span>
        <button className="btn primary" onClick={g.approveUndo}>
          Approve
        </button>
        <button className="btn ghost" onClick={g.rejectUndo}>
          Reject
        </button>
      </>
    ) : g.undo === 'offered' ? (
      <span>
        Undo requested — waiting for your opponent<span className="dots" />
      </span>
    ) : undefined

  return (
    <GameScreen
      state={g.state}
      perspective={g.myColor}
      names={{ W: 'White', R: 'Red' }}
      canAct={g.status === 'playing' && g.myColor === g.state.turn}
      notice={
        g.status === 'peer-left' ? (
          <>
            Opponent disconnected — they can rejoin with code <b>{code}</b>
          </>
        ) : null
      }
      onPlay={g.play}
      onResign={g.resign}
      onUndo={g.requestUndo}
      undoDisabled={!canRequestUndo || g.undo !== 'none'}
      undoBanner={undoBanner}
      onExit={onExit}
      onExplore={onExplore}
      endAction={g.state.result ? endAction : undefined}
    />
  )
}
