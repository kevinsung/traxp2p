import { useState } from 'react'
import { applyMove, newGame, resign } from '../game/engine'
import type { GameState, Move } from '../game/types'

/** Hotseat game: both players share the device; undo steps back one move. */
export function useLocalGame() {
  const [stack, setStack] = useState<GameState[]>(() => [newGame()])
  const state = stack[stack.length - 1]

  return {
    state,
    play(move: Move) {
      const out = applyMove(state, move)
      if (out.ok) setStack((s) => [...s, out.state])
    },
    undo() {
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
    },
    resign() {
      setStack((s) => [...s, resign(s[s.length - 1], s[s.length - 1].turn)])
    },
    reset() {
      setStack([newGame()])
    },
  }
}
