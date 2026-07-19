import { useEffect, useRef, useState } from 'react'
import type { AIRequest, AIResponse } from '../ai/protocol'
import { applyMove, newGame } from '../game/engine'
import { replayTranscript } from '../game/transcript'
import type { GameState, Move } from '../game/types'

export interface ExplorerInit {
  /** Transcript in standard notation; null/invalid falls back to an empty board. */
  moves: string | null
  /** Ply to start viewing at; clamped to the transcript length. */
  ply: number | null
}

function initialLine(init?: ExplorerInit): GameState[] {
  if (!init?.moves) return [newGame()]
  const r = replayTranscript(init.moves)
  return r.ok ? r.line : [newGame()]
}

/**
 * Free-play analysis board: a line of positions (`line[i]` = after `i`
 * plies) with a cursor for the ply currently viewed. Playing a move while
 * viewing an earlier ply branches — the old continuation is discarded.
 *
 * Also drives the search AI in a Web Worker (same engine/config as the
 * vs-computer screen), so the caller can ask it to generate a single move or
 * auto-play both sides from the current position.
 */
export function useExplorer(init?: ExplorerInit) {
  const [line, setLine] = useState<GameState[]>(() => initialLine(init))
  const [cursor, setCursor] = useState<number>(() =>
    Math.max(0, Math.min(init?.ply ?? line.length - 1, line.length - 1)),
  )
  const [thinking, setThinking] = useState(false)
  const [autoPlay, setAutoPlay] = useState(false)
  const workerRef = useRef<Worker | null>(null)
  // In-flight search id; bumping it discards any pending response.
  const requestId = useRef(0)

  const state = line[cursor]
  const plies = line.length - 1

  useEffect(() => {
    const worker = new Worker(new URL('../ai/worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker
    return () => worker.terminate()
  }, [])

  const applyPlay = (move: Move) => {
    const out = applyMove(state, move)
    if (!out.ok) return
    setLine((l) => [...l.slice(0, cursor + 1), out.state])
    setCursor((c) => c + 1)
  }

  const goTo = (ply: number) => setCursor(Math.max(0, Math.min(ply, line.length - 1)))

  // Cancel any in-flight search so a stale response can't land on a position
  // the user has since navigated away from or edited.
  const cancelSearch = () => {
    requestId.current++
    setThinking(false)
  }

  /** Ask the worker for a move in the current position and apply it when it replies. */
  const requestMove = () => {
    const worker = workerRef.current
    if (!worker || thinking || state.result) return
    const id = ++requestId.current
    setThinking(true)
    worker.onmessage = (e: MessageEvent<AIResponse>) => {
      const res = e.data
      if (res.id !== id) return
      setThinking(false)
      if (res.move) applyPlay(res.move)
    }
    const req: AIRequest = { id, board: [...state.board.entries()], turn: state.turn }
    worker.postMessage(req)
  }

  // Auto-play: whenever it's on and the current position isn't over, ask the
  // AI for a move; applying it advances `state`, which re-fires this effect
  // for the next move. Turns itself off once the game ends.
  useEffect(() => {
    if (!autoPlay) return
    if (state.result) {
      setAutoPlay(false)
      return
    }
    requestMove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, state])

  const stop = () => {
    cancelSearch()
    setAutoPlay(false)
  }

  return {
    state,
    line,
    cursor,
    plies,
    thinking,
    autoPlay,
    play(move: Move) {
      stop()
      applyPlay(move)
    },
    goTo(ply: number) {
      stop()
      goTo(ply)
    },
    first: () => {
      stop()
      goTo(0)
    },
    back: () => {
      stop()
      goTo(cursor - 1)
    },
    forward: () => {
      stop()
      goTo(cursor + 1)
    },
    last: () => {
      stop()
      goTo(line.length - 1)
    },
    reset() {
      stop()
      setLine([newGame()])
      setCursor(0)
    },
    load(l: GameState[], ply?: number) {
      stop()
      setLine(l)
      setCursor(Math.max(0, Math.min(ply ?? l.length - 1, l.length - 1)))
    },
    generateMove() {
      if (autoPlay || state.result) return
      requestMove()
    },
    toggleAutoPlay() {
      if (autoPlay) {
        stop()
      } else if (!state.result) {
        setAutoPlay(true)
      }
    },
  }
}
