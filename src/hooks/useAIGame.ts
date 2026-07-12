import { useEffect, useRef, useState } from 'react'
import { applyMove, newGame, otherColor, resign } from '../game/engine'
import type { Color, GameState, Move } from '../game/types'
import type { AIRequest, AIResponse } from '../ai/protocol'

/** Minimum apparent think time so instant replies don't feel jarring. */
const MIN_THINK_MS = 400

/**
 * Undo for a vs-computer game: drop back to the latest live position where it
 * is the human's turn, always removing at least one state. After a full
 * human+AI exchange this removes both plies; mid-think it removes just the
 * human's move; after a loss it rewinds past the losing exchange.
 */
export function undoTo(stack: GameState[], humanColor: Color): GameState[] {
  if (stack.length <= 1) return stack
  let n = stack.length - 1
  while (n > 1 && !(stack[n - 1].turn === humanColor && !stack[n - 1].result)) n--
  return stack.slice(0, n)
}

/** Game against the computer; the AI searches in a Web Worker. */
export function useAIGame(humanColor: Color) {
  const aiColor = otherColor(humanColor)
  const [stack, setStack] = useState<GameState[]>(() => [newGame()])
  const [thinking, setThinking] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  // In-flight search id; bumping it discards any pending response.
  const requestId = useRef(0)
  const state = stack[stack.length - 1]

  useEffect(() => {
    const worker = new Worker(new URL('../ai/worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    // No ref cleanup needed: a response landing after unmount is dropped by
    // React (setState on an unmounted component is a no-op).
    return () => worker.terminate()
  }, [])

  useEffect(() => {
    const worker = workerRef.current
    if (state.result || state.turn !== aiColor || !worker) return
    const id = ++requestId.current
    const started = performance.now()
    setThinking(true)
    worker.onmessage = (e: MessageEvent<AIResponse>) => {
      const res = e.data
      if (res.id !== id) return
      const finish = () => {
        if (id !== requestId.current) return // undone / reset meanwhile
        setThinking(false)
        if (!res.move) return
        setStack((s) => {
          const out = applyMove(s[s.length - 1], res.move!)
          return out.ok ? [...s, out.state] : s
        })
      }
      setTimeout(finish, Math.max(0, MIN_THINK_MS - (performance.now() - started)))
    }
    const req: AIRequest = { id, board: [...state.board.entries()], turn: state.turn }
    worker.postMessage(req)
  }, [state, aiColor])

  const cancelSearch = () => {
    requestId.current++
    setThinking(false)
  }

  return {
    state,
    aiColor,
    thinking,
    play(move: Move) {
      if (thinking || state.result || state.turn !== humanColor) return
      const out = applyMove(state, move)
      if (out.ok) setStack((s) => [...s, out.state])
    },
    undo() {
      cancelSearch()
      setStack((s) => undoTo(s, humanColor))
    },
    resign() {
      cancelSearch()
      setStack((s) => [...s, resign(s[s.length - 1], humanColor)])
    },
    reset() {
      cancelSearch()
      setStack([newGame()])
    },
  }
}
