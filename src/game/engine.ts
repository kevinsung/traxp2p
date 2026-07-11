import { DIRS, key, neighbor, opposite } from './board'
import { encodeMove } from './notation'
import { edgeColor, FIRST_TILES, tileFromEdges } from './tiles'
import { detectWins } from './wins'
import type { Board, Color, Coord, GameResult, GameState, Move, MoveRecord, PlacedTile } from './types'

export function newGame(): GameState {
  return { board: new Map(), turn: 'W', history: [], result: null }
}

export const otherColor = (c: Color): Color => (c === 'W' ? 'R' : 'W')

export type MoveOutcome = { ok: true; state: GameState } | { ok: false; reason: string }

const no = (reason: string): MoveOutcome => ({ ok: false, reason })

/**
 * Validate and apply a move: place the tile, resolve the forced-play cascade,
 * and detect wins. Returns the new state or the reason the move is illegal.
 */
export function applyMove(state: GameState, move: Move): MoveOutcome {
  if (state.result) return no('the game is over')
  const { x, y, tile } = move
  if (state.board.has(key(x, y))) return no('that space is occupied')

  if (state.board.size === 0) {
    if (x !== 0 || y !== 0) return no('the first tile must be played at the origin')
    if (!FIRST_TILES.includes(tile)) return no('the first tile must be a canonical opening')
  } else {
    let touches = false
    for (const d of DIRS) {
      const n = neighbor(x, y, d)
      const nt = state.board.get(key(n.x, n.y))
      if (!nt) continue
      touches = true
      if (edgeColor(nt, opposite(d)) !== edgeColor(tile, d)) return no('track colors do not match')
    }
    if (!touches) return no('the tile must touch an existing tile')
  }

  const notation = encodeMove(state.board, move)
  const board: Board = new Map(state.board)
  board.set(key(x, y), tile)
  const placed: PlacedTile[] = [{ ...move, forced: false }]

  // Forced play: any empty space with 2+ same-colored edges facing into it
  // must be filled with the unique tile that fits; fills cascade. A space
  // with 3+ same-colored edges admits no tile, making the move illegal.
  // Every placement re-enqueues its empty neighbors, so a space is always
  // re-examined after gaining a constraint; the result is order-independent
  // because a forced tile is determined by all of its occupied neighbors.
  const queue: Coord[] = emptyNeighbors(board, x, y)
  while (queue.length > 0) {
    const c = queue.pop()!
    const ck = key(c.x, c.y)
    if (board.has(ck)) continue
    const edges: (Color | null)[] = [null, null, null, null]
    let w = 0
    let r = 0
    for (const d of DIRS) {
      const n = neighbor(c.x, c.y, d)
      const nt = board.get(key(n.x, n.y))
      if (!nt) continue
      const col = edgeColor(nt, opposite(d))
      edges[d] = col
      if (col === 'W') w++
      else r++
    }
    if (w > 2 || r > 2) return no('the move forces a space no tile can fill')
    if (w < 2 && r < 2) continue
    const fill: Color = w >= 2 ? 'R' : 'W'
    const forcedTile = tileFromEdges(edges.map((col) => col ?? fill) as [Color, Color, Color, Color])!
    board.set(ck, forcedTile)
    placed.push({ x: c.x, y: c.y, tile: forcedTile, forced: true })
    queue.push(...emptyNeighbors(board, c.x, c.y))
  }

  const winPaths = detectWins(board, placed)
  let result: GameResult | null = null
  if (winPaths.length > 0) {
    const whiteWon = winPaths.some((p) => p.color === 'W')
    const redWon = winPaths.some((p) => p.color === 'R')
    // A move can complete either player's track; if it completes both, the
    // player who made the move wins.
    const winner: Color = whiteWon && redWon ? state.turn : whiteWon ? 'W' : 'R'
    const paths = winPaths.filter((p) => p.color === winner)
    result = { winner, reason: paths.some((p) => p.kind === 'loop') ? 'loop' : 'line', paths }
  }

  const record: MoveRecord = { player: state.turn, move, placed, notation }
  return {
    ok: true,
    state: { board, turn: otherColor(state.turn), history: [...state.history, record], result },
  }
}

export function resign(state: GameState, player: Color): GameState {
  if (state.result) return state
  return { ...state, result: { winner: otherColor(player), reason: 'resignation', paths: [] } }
}

function emptyNeighbors(board: Board, x: number, y: number): Coord[] {
  return DIRS.map((d) => neighbor(x, y, d)).filter((n) => !board.has(key(n.x, n.y)))
}

/** Order-independent FNV-1a hash of the position; used for P2P desync checks. */
export function hashState(state: GameState): string {
  const parts = [...state.board.entries()].map(([k, t]) => `${k}:${t}`).sort()
  parts.push(`turn:${state.turn}`, `n:${state.history.length}`)
  let h = 0x811c9dc5
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
