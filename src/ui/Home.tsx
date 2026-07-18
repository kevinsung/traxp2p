import { useState } from 'react'
import { normalizeCode } from '../net/room'
import type { Color } from '../game/types'
import { Logo } from './Logo'

export interface HomeProps {
  onLocal: () => void
  onComputer: (human: Color) => void
  onCreate: () => void
  onJoin: (code: string) => void
  onRules: () => void
  onExplore: () => void
}

type ColorChoice = Color | 'random'

const COLOR_CHOICES: Array<{ value: ColorChoice; label: string }> = [
  { value: 'W', label: 'White' },
  { value: 'R', label: 'Red' },
  { value: 'random', label: 'Random' },
]

export function Home({ onLocal, onComputer, onCreate, onJoin, onRules, onExplore }: HomeProps) {
  const [code, setCode] = useState('')
  const [colorChoice, setColorChoice] = useState<ColorChoice>('W')

  return (
    <div className="home">
      <Logo />

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

        <div className="home-card join-card">
          <span className="home-card-title">Play the computer</span>
          <div className="seg-row" role="radiogroup" aria-label="Your color">
            {COLOR_CHOICES.map(({ value, label }) => (
              <button
                key={value}
                role="radio"
                aria-checked={colorChoice === value}
                className={colorChoice === value ? 'selected' : ''}
                onClick={() => setColorChoice(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            className="btn primary"
            onClick={() =>
              onComputer(colorChoice === 'random' ? (Math.random() < 0.5 ? 'W' : 'R') : colorChoice)
            }
          >
            Start
          </button>
        </div>

        <button className="home-card" onClick={onExplore}>
          <span className="home-card-title">Trax explorer</span>
          <span className="home-card-sub">Explore positions, share via URL</span>
        </button>

        <button className="home-card" onClick={onRules}>
          <span className="home-card-title">How to play</span>
          <span className="home-card-sub">Rules of Trax</span>
        </button>
      </div>
    </div>
  )
}
