import { ALL_TILES } from '../game/tiles'
import { LINE_SPAN } from '../game/wins'
import { WEIGHTS, WIN_SCORE } from './eval'
import { cellX, cellY, DELTA, DX, DY, FastBoard, ILLEGAL, OTHER_END, TILE_CODE } from './fastboard'
import type { GameState, Move, TileKind } from '../game/types'
import type { SearchLimits, SearchResult } from './search'

/**
 * v2 search: the same iterative-deepening negamax as search.ts, run over a
 * mutable FastBoard with make/unmake instead of immutable engine states. The
 * node rate is ~10-50x v1's, which buys extra plies at the same time budget.
 * Public shape matches v1 so it drops into searchAgent and the worker.
 */

/** Fixed strength of the app's computer opponent (same budget as v1). */
export const AI_LIMITS: SearchLimits = { budgetMs: 1500, maxDepth: 16, topMargin: 5 }

// --- Evaluation: faithful int port of src/ai/eval.ts --------------------------

// Component bounds tracked by walkEval (module scratch; search is single-threaded).
let compMinX = 0
let compMaxX = 0
let compMinY = 0
let compMaxY = 0

/**
 * Walk `color`'s track from `startCell` leaving in direction `d`, marking
 * visited and growing the comp* bounds. Returns -1 for a loop, else the open
 * end packed as cell*4 + exitDir.
 */
function walkEval(fb: FastBoard, startCell: number, d: number, color: number, visited: Set<number>): number {
  let cur = startCell
  for (;;) {
    const n = cur + DELTA[d]
    const nt = fb.tiles.get(n)
    if (nt === undefined) return cur * 4 + d
    if (n === startCell) return -1
    visited.add(n * 2 + color)
    const x = cellX(n)
    const y = cellY(n)
    if (x < compMinX) compMinX = x
    if (x > compMaxX) compMaxX = x
    if (y < compMinY) compMinY = y
    if (y > compMaxY) compMaxY = y
    d = OTHER_END[nt * 4 + ((d + 2) & 3)]
    cur = n
  }
}

/** Port of eval.ts loopThreat over exit coordinates and end directions. */
function loopThreat(eaX: number, eaY: number, ebX: number, ebY: number, dA: number, dB: number): number {
  const dist = Math.abs(eaX - ebX) + Math.abs(eaY - ebY)
  if (dist === 0) return WEIGHTS.loop
  if (dA === ((dB + 2) & 3)) {
    if (DX[dA] * (ebX - eaX) + DY[dA] * (ebY - eaY) <= 0) return 0
  }
  return WEIGHTS.loop / (dist * dist)
}

/** Port of eval.ts linePotential's per-axis term. */
function axisPotential(span: number, openA: boolean, openB: boolean): number {
  const open = (openA ? 1 : 0) + (openB ? 1 : 0)
  if (open === 0) return 0
  if (open === 2 && span >= LINE_SPAN - 1) return WEIGHTS.lineDouble
  const mult = open === 2 ? 1.5 : 0.75
  return WEIGHTS.line * mult * (Math.min(span, LINE_SPAN) / LINE_SPAN) ** 2
}

const evalVisited = new Set<number>()

/**
 * Heuristic score of a non-terminal position for White; identical math to
 * eval.ts evaluate (tempo + loop threats + end-aware line potential).
 * evaluate-for-color is this value negated for Red (antisymmetric).
 */
function evalWhite(fb: FastBoard): number {
  let score = fb.turn === 0 ? WEIGHTS.tempo : -WEIGHTS.tempo
  const visited = evalVisited
  visited.clear()
  for (const cell of fb.tiles.keys()) {
    const code = TILE_CODE[fb.tiles.get(cell)!]
    for (let color = 0; color < 2; color++) {
      if (visited.has(cell * 2 + color)) continue
      visited.add(cell * 2 + color)
      let d1 = -1
      let d2 = -1
      for (let d = 0; d < 4; d++) {
        if (((code >>> d) & 1) === color) {
          if (d1 < 0) d1 = d
          else d2 = d
        }
      }
      compMinX = compMaxX = cellX(cell)
      compMinY = compMaxY = cellY(cell)
      const endA = walkEval(fb, cell, d1, color, visited)
      let v = 0
      if (endA !== -1) {
        // A closed loop scores 0 here, exactly as in eval.ts (it is terminal
        // anyway and never reached by eval in a live search).
        const endB = walkEval(fb, cell, d2, color, visited)
        const aCell = Math.floor(endA / 4)
        const aDir = endA & 3
        const bCell = Math.floor(endB / 4)
        const bDir = endB & 3
        const eaX = cellX(aCell) + DX[aDir]
        const eaY = cellY(aCell) + DY[aDir]
        const ebX = cellX(bCell) + DX[bDir]
        const ebY = cellY(bCell) + DY[bDir]
        v += loopThreat(eaX, eaY, ebX, ebY, aDir, bDir)
        const vert = axisPotential(compMaxY - compMinY + 1, eaY < compMinY || ebY < compMinY, eaY > compMaxY || ebY > compMaxY)
        const horiz = axisPotential(compMaxX - compMinX + 1, eaX < compMinX || ebX < compMinX, eaX > compMaxX || ebX > compMaxX)
        v += Math.max(vert, horiz)
      }
      score += color === 0 ? v : -v
    }
  }
  return score
}

/** Bounded position→evalWhite cache, keyed by the turn-salted 53-bit hash. */
const EVAL_CACHE_MAX = 250_000
const evalCache = new Map<number, number>()

function evalFor(fb: FastBoard, mover: number): number {
  const h = fb.hash()
  let v = evalCache.get(h)
  if (v === undefined) {
    v = evalWhite(fb)
    if (evalCache.size >= EVAL_CACHE_MAX) evalCache.clear()
    evalCache.set(h, v)
  }
  return mover === 0 ? v : -v
}

// --- Search --------------------------------------------------------------------

const FLAG_EXACT = 0
const FLAG_LOWER = 1
const FLAG_UPPER = 2

/**
 * Persistent transposition table: fixed-size structure-of-arrays, shared
 * across chooseMove calls (and games — safe because the 53-bit hash encodes
 * the full position + turn and Trax legality is history-free, so an entry can
 * never go stale). ~24 MB resident in the worker.
 */
const TT_SLOTS = 1 << 20
const ttKey = new Float64Array(TT_SLOTS) // 53-bit hash; 0 = empty slot
const ttScore = new Float64Array(TT_SLOTS)
const ttMeta = new Int32Array(TT_SLOTS) // depth | flag<<8 | gen<<10
const ttMove = new Int32Array(TT_SLOTS) // best move packed as cell*8 + tile, or -1
let ttGen = 0

const GEN_MASK = 0x3fffff // 22 bits; wraps harmlessly (staleness is only a replacement hint)

/** Replace shallower or older-generation entries; keep deep current ones. */
function ttStore(hash: number, depth: number, score: number, flag: number, best: number): void {
  const slot = hash % TT_SLOTS
  const meta = ttMeta[slot]
  if (ttKey[slot] !== 0 && ttKey[slot] !== hash && depth < (meta & 0xff) && meta >>> 10 === ttGen) return
  ttKey[slot] = hash
  ttScore[slot] = score
  ttMeta[slot] = depth | (flag << 8) | (ttGen << 10)
  ttMove[slot] = best
}

/** Killer-move slots: 2 per ply. */
const MAX_PLY = 128

interface Ctx {
  fb: FastBoard
  nodes: number
  deadline: number
  maxNodes: number
  /** One reusable move buffer per ply, so recursion never clobbers a live list. */
  movesAtPly: number[][]
  /** Ordering-key scratch, parallel to movesAtPly. */
  keysAtPly: number[][]
  /** Two killer moves per ply (packed ints, -1 = empty). */
  killers: Int32Array
  /** Move int → cutoff credit, bumped depth² on beta cutoff, halved when large. */
  history: Map<number, number>
}

/**
 * Order moves for the search: TT move, killers for this ply, then by history
 * credit. Cheap (no child evals) — exactly what make/unmake speed pays for.
 */
function orderMoves(ctx: Ctx, moves: number[], ttMove: number, ply: number): void {
  const n = moves.length
  const keys = (ctx.keysAtPly[ply] ??= [])
  keys.length = n
  const k0 = ctx.killers[ply * 2]
  const k1 = ctx.killers[ply * 2 + 1]
  for (let i = 0; i < n; i++) {
    const mv = moves[i]
    keys[i] = mv === ttMove ? Infinity : mv === k0 ? 2e9 : mv === k1 ? 1e9 : (ctx.history.get(mv) ?? 0)
  }
  for (let i = 1; i < n; i++) {
    const mv = moves[i]
    const k = keys[i]
    let j = i - 1
    while (j >= 0 && keys[j] < k) {
      moves[j + 1] = moves[j]
      keys[j + 1] = keys[j]
      j--
    }
    moves[j + 1] = mv
    keys[j + 1] = k
  }
}

/** Credit a beta cutoff: promote to killer slot 0 and bump history by depth². */
function creditCutoff(ctx: Ctx, mv: number, depth: number, ply: number): void {
  if (ctx.killers[ply * 2] !== mv) {
    ctx.killers[ply * 2 + 1] = ctx.killers[ply * 2]
    ctx.killers[ply * 2] = mv
  }
  const bumped = (ctx.history.get(mv) ?? 0) + depth * depth
  if (bumped > 1e8) {
    for (const [k, v] of ctx.history) ctx.history.set(k, v / 2)
    ctx.history.set(mv, bumped / 2)
  } else {
    ctx.history.set(mv, bumped)
  }
}

const TIMEOUT = Symbol('search timeout')

/** Count a node expansion; abort the current iteration when out of budget. */
function bump(ctx: Ctx): void {
  ctx.nodes++
  if ((ctx.nodes & 0xff) === 0 && (performance.now() > ctx.deadline || ctx.nodes > ctx.maxNodes)) {
    throw TIMEOUT
  }
}

/**
 * Score the move just made (status from make()) for `mover`; recurses when
 * the child is non-terminal and depth remains. A move can complete the
 * opponent's track, so terminals score by the actual winner.
 */
function madeScore(ctx: Ctx, status: number, mover: number, depth: number, alpha: number, beta: number, ply: number): number {
  if (status !== 0) {
    return status - 1 === mover ? WIN_SCORE - (ply + 1) : -(WIN_SCORE - (ply + 1))
  }
  if (depth <= 1) return evalFor(ctx.fb, mover)
  return -negamax(ctx, depth - 1, -beta, -alpha, ply + 1)
}

/** Negamax with alpha-beta over `depth` further plies; the board is non-terminal. */
function negamax(ctx: Ctx, depth: number, alpha: number, beta: number, ply: number): number {
  const fb = ctx.fb
  const alphaOrig = alpha
  const hash = fb.hash()
  const slot = hash % TT_SLOTS
  const hit = ttKey[slot] === hash
  if (hit && (ttMeta[slot] & 0xff) >= depth) {
    const score = ttScore[slot]
    const flag = (ttMeta[slot] >>> 8) & 3
    if (flag === FLAG_EXACT) return score
    if (flag === FLAG_LOWER && score > alpha) alpha = score
    else if (flag === FLAG_UPPER && score < beta) beta = score
    if (alpha >= beta) return score
  }

  bump(ctx)
  const moves = (ctx.movesAtPly[ply] ??= [])
  fb.moves(moves)
  // TT move first (legality is still make()-checked, so a hash collision can
  // only cost ordering quality, never correctness), then killers + history.
  orderMoves(ctx, moves, hit ? ttMove[slot] : -1, ply)

  const mover = fb.turn
  let best = -Infinity
  let bestMove = -1
  let legal = 0
  for (let i = 0; i < moves.length; i++) {
    const mv = moves[i]
    const status = fb.make(Math.floor(mv / 8), mv & 7)
    if (status === ILLEGAL) continue
    legal++
    const s = madeScore(ctx, status, mover, depth, alpha, beta, ply)
    fb.unmake()
    if (s > best) {
      best = s
      bestMove = mv
    }
    if (s > alpha) alpha = s
    if (alpha >= beta) {
      creditCutoff(ctx, mv, depth, ply)
      break
    }
  }
  if (legal === 0) return -(WIN_SCORE - ply) // no legal move: mover loses

  const flag = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT
  ttStore(hash, depth, best, flag, bestMove)
  return best
}

interface RootScore {
  mv: number
  score: number
}

/**
 * Score every root move to `depth` with alpha trailing the best by `margin`,
 * exactly like v1's searchRoot: near-best moves keep exact scores for the
 * random tie-break pool while clearly worse ones still prune.
 */
function searchRoot(ctx: Ctx, moves: number[], depth: number, margin: number): RootScore[] {
  const out: RootScore[] = []
  const mover = ctx.fb.turn
  let best = -Infinity
  for (const mv of moves) {
    const alpha = best === -Infinity ? -Infinity : best - margin - 1
    const status = ctx.fb.make(Math.floor(mv / 8), mv & 7)
    if (status === ILLEGAL) continue
    const s = madeScore(ctx, status, mover, depth, alpha, Infinity, 0)
    ctx.fb.unmake()
    out.push({ mv, score: s })
    if (s > best) best = s
  }
  return out
}

const toMove = (mv: number): Move => ({
  x: cellX(Math.floor(mv / 8)),
  y: cellY(Math.floor(mv / 8)),
  tile: ALL_TILES[mv & 7] as TileKind,
})

/**
 * Pick a move by iterative-deepening negamax within the given limits; same
 * contract and root behavior (margin pool + rand tie-break) as v1 chooseMove.
 */
export function chooseMove(state: GameState, limits: SearchLimits): SearchResult | null {
  if (state.result) return null
  const fb = FastBoard.fromState(state)
  const gen: number[] = []
  fb.moves(gen)
  const rootMoves: number[] = []
  for (const mv of gen) {
    const status = fb.make(Math.floor(mv / 8), mv & 7)
    if (status === ILLEGAL) continue
    fb.unmake()
    rootMoves.push(mv)
  }
  if (rootMoves.length === 0) return null

  const rand = limits.rand ?? Math.random
  const margin = limits.topMargin ?? 0
  ttGen = (ttGen + 1) & GEN_MASK
  const ctx: Ctx = {
    fb,
    nodes: 0,
    deadline: performance.now() + limits.budgetMs,
    maxNodes: limits.maxNodes ?? Infinity,
    movesAtPly: [],
    keysAtPly: [],
    killers: new Int32Array(MAX_PLY * 2).fill(-1),
    history: new Map(),
  }

  let scores: RootScore[] = []
  let completedDepth = 0
  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    try {
      scores = searchRoot(ctx, rootMoves, depth, margin)
      completedDepth = depth
    } catch (e) {
      if (e !== TIMEOUT) throw e
      while (fb.depth() > 0) fb.unmake() // unwind the aborted line
      break // keep the previous completed iteration
    }
    // Search best-first on the next iteration.
    scores.sort((a, b) => b.score - a.score)
    rootMoves.splice(0, rootMoves.length, ...scores.map((s) => s.mv))
    const top = scores[0].score
    if (top >= WIN_SCORE - 100 || top <= -(WIN_SCORE - 100)) break // decided
    if (performance.now() > ctx.deadline) break
  }

  const best = scores.reduce((a, b) => (b.score > a.score ? b : a))
  const pool = scores.filter((s) => s.score >= best.score - margin)
  const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]
  return { move: toMove(pick.mv), score: pick.score, depth: completedDepth, nodes: ctx.nodes }
}
