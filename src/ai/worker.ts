import { AI_LIMITS, chooseMove } from './search2'
import type { GameState } from '../game/types'
import type { AIRequest, AIResponse } from './protocol'

// Cast instead of the webworker lib to avoid clashing with the app's DOM lib.
const ctx = self as unknown as Worker

ctx.onmessage = (e: MessageEvent<AIRequest>) => {
  const { id, board, turn } = e.data
  const state: GameState = { board: new Map(board), turn, history: [], result: null }
  const r = chooseMove(state, AI_LIMITS)
  const res: AIResponse = {
    id,
    move: r?.move ?? null,
    score: r?.score ?? 0,
    depth: r?.depth ?? 0,
    nodes: r?.nodes ?? 0,
  }
  ctx.postMessage(res)
}
