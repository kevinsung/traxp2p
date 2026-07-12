import { parseKey } from '../game/board'
import { applyMove } from '../game/engine'
import { candidateCells } from '../game/moves'
import { ALL_TILES, FIRST_TILES } from '../game/tiles'
import { evaluate, WIN_SCORE } from './eval'
import type { Board, Color, GameState, Move } from '../game/types'

export interface SearchLimits {
  budgetMs: number
  maxDepth: number
  /** Node-expansion cap; makes test searches deterministic. */
  maxNodes?: number
  /** Random source for root tie-breaking; defaults to Math.random. */
  rand?: () => number
  /** Pick uniformly among root moves scoring within this margin of the best. */
  topMargin?: number
}

export interface SearchResult {
  move: Move
  score: number
  depth: number
  nodes: number
}

/** Fixed strength of the app's computer opponent. */
export const AI_LIMITS: SearchLimits = { budgetMs: 1500, maxDepth: 16, topMargin: 5 }

/** A legal move together with the state it leads to. */
interface Edge {
  move: Move
  child: GameState
}

/**
 * All legal moves with their resulting states. Calls applyMove directly and
 * keeps the outcome (unlike legalMoves, which discards it), so search never
 * applies a move twice.
 */
export function expand(state: GameState): Edge[] {
  const tiles = state.board.size === 0 ? FIRST_TILES : ALL_TILES
  const out: Edge[] = []
  for (const cell of candidateCells(state.board)) {
    for (const tile of tiles) {
      const move = { x: cell.x, y: cell.y, tile }
      const r = applyMove(state, move)
      if (r.ok) out.push({ move, child: r.state })
    }
  }
  return out
}

const TURN_SALT: Record<Color, number> = { W: 0x9e3779b9, R: 0x7f4a7c15 }

function mixCell(x: number, y: number, tileIndex: number, c1: number, c2: number): number {
  let h = (Math.imul(x, c1) ^ Math.imul(y, c2) ^ Math.imul(tileIndex + 1, 0x27d4eb2f)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12
  return h >>> 0
}

/**
 * Order-independent 53-bit position hash (two independent 32-bit XOR hashes
 * packed together), keyed on tiles and side to move. Used as the transposition
 * table key; 53 bits keep collisions negligible at search sizes.
 */
export function positionHash(board: Board, turn: Color): number {
  let h1 = TURN_SALT[turn]
  let h2 = ~TURN_SALT[turn] >>> 0
  for (const [k, tile] of board) {
    const { x, y } = parseKey(k)
    const t = ALL_TILES.indexOf(tile)
    h1 = (h1 ^ mixCell(x, y, t, 0x85ebca6b, 0xc2b2ae35)) >>> 0
    h2 = (h2 ^ mixCell(x, y, t, 0x9e3779b1, 0x165667b1)) >>> 0
  }
  return h1 * 0x200000 + (h2 >>> 11)
}

type Flag = 'exact' | 'lower' | 'upper'

interface TTEntry {
  depth: number
  score: number
  flag: Flag
  best: Move | null
}

interface Ctx {
  tt: Map<number, TTEntry>
  nodes: number
  deadline: number
  maxNodes: number
}

const TIMEOUT = Symbol('search timeout')

/** Count a node expansion; abort the current iteration when out of budget. */
function bump(ctx: Ctx): void {
  ctx.nodes++
  if ((ctx.nodes & 0xff) === 0 && (performance.now() > ctx.deadline || ctx.nodes > ctx.maxNodes)) {
    throw TIMEOUT
  }
}

const sameMove = (a: Move, b: Move): boolean => a.x === b.x && a.y === b.y && a.tile === b.tile

/**
 * Score a child state from the mover's perspective. A move can complete the
 * opponent's track (engine awards by result.winner, not mover), so terminal
 * children must be scored by who actually won.
 */
function childScore(ctx: Ctx, mover: Color, edge: Edge, depth: number, alpha: number, beta: number, ply: number): number {
  const { child } = edge
  if (child.result) {
    return child.result.winner === mover ? WIN_SCORE - (ply + 1) : -(WIN_SCORE - (ply + 1))
  }
  if (depth <= 1) return evaluate(child, mover)
  return -negamax(ctx, child, depth - 1, -beta, -alpha, ply + 1)
}

/** Sort: winning terminals, then the TT move, then children by static eval. */
function orderEdges(edges: Edge[], mover: Color, ttMove: Move | null, depth: number): void {
  const score = new Map<Edge, number>()
  for (const e of edges) {
    let s = 0
    if (e.child.result) s = e.child.result.winner === mover ? 1e9 : -1e9
    else if (depth >= 2) s = evaluate(e.child, mover)
    if (ttMove && sameMove(e.move, ttMove)) s += 1e8
    score.set(e, s)
  }
  edges.sort((a, b) => score.get(b)! - score.get(a)!)
}

/** Negamax with alpha-beta over `depth` further plies; `state` is non-terminal. */
function negamax(ctx: Ctx, state: GameState, depth: number, alpha: number, beta: number, ply: number): number {
  const alphaOrig = alpha
  const hash = positionHash(state.board, state.turn)
  const entry = ctx.tt.get(hash)
  if (entry && entry.depth >= depth) {
    if (entry.flag === 'exact') return entry.score
    if (entry.flag === 'lower' && entry.score > alpha) alpha = entry.score
    else if (entry.flag === 'upper' && entry.score < beta) beta = entry.score
    if (alpha >= beta) return entry.score
  }

  bump(ctx)
  const edges = expand(state)
  if (edges.length === 0) return -(WIN_SCORE - ply) // no legal move: mover loses

  orderEdges(edges, state.turn, entry?.best ?? null, depth)

  let best = -Infinity
  let bestMove: Move | null = null
  for (const edge of edges) {
    const s = childScore(ctx, state.turn, edge, depth, alpha, beta, ply)
    if (s > best) {
      best = s
      bestMove = edge.move
    }
    if (s > alpha) alpha = s
    if (alpha >= beta) break
  }

  const flag: Flag = best <= alphaOrig ? 'upper' : best >= beta ? 'lower' : 'exact'
  ctx.tt.set(hash, { depth, score: best, flag, best: bestMove })
  return best
}

interface RootScore {
  edge: Edge
  score: number
}

/**
 * Score every root move to `depth`. Alpha trails the best score by `margin`
 * so that near-best moves keep exact scores (usable for random tie-breaking)
 * while everything clearly worse still gets pruned.
 */
function searchRoot(ctx: Ctx, edges: Edge[], mover: Color, depth: number, margin: number): RootScore[] {
  const out: RootScore[] = []
  let best = -Infinity
  for (const edge of edges) {
    const alpha = best === -Infinity ? -Infinity : best - margin - 1
    const s = childScore(ctx, mover, edge, depth, alpha, Infinity, 0)
    out.push({ edge, score: s })
    if (s > best) best = s
  }
  return out
}

/**
 * Pick a move by iterative-deepening negamax within the given limits.
 * Deepening stops at the deadline/node cap, keeping the last completed
 * iteration. Returns null only if the game is over or no move exists.
 */
export function chooseMove(state: GameState, limits: SearchLimits): SearchResult | null {
  if (state.result) return null
  const rootEdges = expand(state)
  if (rootEdges.length === 0) return null

  const rand = limits.rand ?? Math.random
  const margin = limits.topMargin ?? 0
  const ctx: Ctx = {
    tt: new Map(),
    nodes: 0,
    deadline: performance.now() + limits.budgetMs,
    maxNodes: limits.maxNodes ?? Infinity,
  }

  let scores: RootScore[] = []
  let completedDepth = 0
  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    try {
      scores = searchRoot(ctx, rootEdges, state.turn, depth, margin)
      completedDepth = depth
    } catch (e) {
      if (e === TIMEOUT) break // keep the previous completed iteration
      throw e
    }
    // Search best-first on the next iteration.
    scores.sort((a, b) => b.score - a.score)
    rootEdges.splice(0, rootEdges.length, ...scores.map((s) => s.edge))
    const top = scores[0].score
    if (top >= WIN_SCORE - 100 || top <= -(WIN_SCORE - 100)) break // decided
    if (performance.now() > ctx.deadline) break
  }

  const best = scores.reduce((a, b) => (b.score > a.score ? b : a))
  const pool = scores.filter((s) => s.score >= best.score - margin)
  const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
  return { move: pick.edge.move, score: pick.score, depth: completedDepth, nodes: ctx.nodes }
}
