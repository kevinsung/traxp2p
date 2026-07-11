import { useState } from 'react'
import { normalizeCode } from '../net/room'

export interface HomeProps {
  onLocal: () => void
  onCreate: () => void
  onJoin: (code: string) => void
  onRules: () => void
}

export function Home({ onLocal, onCreate, onJoin, onRules }: HomeProps) {
  const [code, setCode] = useState('')

  return (
    <div className="home">
      <h1 className="logo">TRAX</h1>

      <div className="home-cards">
        <button className="home-card" onClick={onLocal}>
          <span className="home-card-title">Local game</span>
          <span className="home-card-sub">Two players, one device</span>
        </button>

        <button className="home-card" onClick={onCreate}>
          <span className="home-card-title">Create room</span>
          <span className="home-card-sub">Play a friend over the Internet</span>
        </button>

        <form
          className="home-card join-card"
          onSubmit={(e) => {
            e.preventDefault()
            if (normalizeCode(code).length >= 4) onJoin(normalizeCode(code))
          }}
        >
          <span className="home-card-title">Join room</span>
          <div className="join-row">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="Room code"
              maxLength={8}
              aria-label="Room code"
            />
            <button type="submit" className="btn primary" disabled={normalizeCode(code).length < 4}>
              Join
            </button>
          </div>
        </form>

        <button className="home-card" onClick={onRules}>
          <span className="home-card-title">How to play</span>
          <span className="home-card-sub">Rules of Trax</span>
        </button>
      </div>
    </div>
  )
}
