import { applyMove, newGame } from './engine'
import { decodeMove } from './notation'
import type { GameState, MoveRecord } from './types'

/** Standard-notation transcript: each move's token, space-separated. */
export function encodeMoves(history: MoveRecord[]): string {
  return history.map((r) => r.notation).join(' ')
}

export type ReplayResult = { ok: true; line: GameState[] } | { ok: false; error: string }

/**
 * Replay a transcript from the empty board. Returns every intermediate state
 * (`line[i]` is the position after `i` plies) so callers get positions and
 * the full game in one pass, or the reason the transcript is invalid.
 */
export function replayTranscript(text: string): ReplayResult {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const line: GameState[] = [newGame()]
  for (const token of tokens) {
    const cur = line[line.length - 1]
    const move = decodeMove(cur.board, token)
    if (!move) return { ok: false, error: `not a legal move: "${token}"` }
    const out = applyMove(cur, move)
    if (!out.ok) return { ok: false, error: `${token}: ${out.reason}` }
    line.push(out.state)
  }
  return { ok: true, line }
}
