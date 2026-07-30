import { ALL_TILES } from '../game/tiles'
import { LINE_SPAN } from '../game/wins'
import { FIT_WEIGHTS } from './eval-fit'
import { WEIGHTS, WIN_SCORE } from './eval'
import {
  F_LINE1_S3,
  F_LINE2_S3,
  F_LINE2_S6,
  F_LINE_DOUBLE,
  F_LOOP_BLOCKED,
  F_LOOP_D1,
  F_LOOP_D2,
  F_LOOP_D3,
  F_LOOP_FAR,
  F_TEMPO,
  F_TWO_THREAT,
} from './features'
import { CELL_CODE, CELL_OTHER_END, CELL_SPACE, cellOf, cellX, cellY, DELTA, DX, DY, FastBoard, ILLEGAL, nextGen } from './fastboard'
import type { GameState, Move, TileKind } from '../game/types'
import type { SearchLimits, SearchResult } from './search'

/**
 * VARIANT under gate — the shipped search with a **fitted** evaluation.
 *
 * Byte-for-byte src/ai/search2.ts from the eval cache down; only `evalWhite`'s
 * body differs. Instead of the hand-written terms it is the dot product of
 * `FIT_WEIGHTS` with the feature basis of src/ai/features.ts, fitted to the
 * outcomes of 230k self-play positions (`core+G3+G4`: tempo and the two-threat
 * cliff, plus loop-separation and per-axis line buckets in place of the smooth
 * 100/dist² and max-of-axes curves). Val loss 0.66610 against the shipped
 * eval's 0.69225.
 *
 * **It keeps the `closesInOne` mover short-circuit.** That is deliberate and it
 * is the difference between this and the abandoned `ml`-branch attempt: a
 * verified win in one is worth +2.0pt (docs/ai-arena.md, 2026-07-26) and it is a
 * *mechanism*, not a weight — no reweighting of positional features reproduces
 * "the side to move can simply play it". The corpus deliberately excludes those
 * positions for the same reason, so the fit has nothing to say about them.
 *
 * Registered as `fit`. Dead code as far as the app bundle is concerned
 * (src/ai/worker.ts imports only ./search2) — which matters here, because
 * importing ./features would otherwise drag a 4 MB stamp lane into the worker.
 * Promotion would mean inlining the weights and the bucket code, not shipping
 * this import graph.
 */

export const AI_LIMITS: SearchLimits = { budgetMs: 1500, maxDepth: 16, topMargin: 1 }

// --- Evaluation: FIT_WEIGHTS · features, fused into one walk -------------------

// Component bounds tracked by walkEval (module scratch; search is single-threaded).
let compMinX = 0
let compMaxX = 0
let compMinY = 0
let compMaxY = 0

/**
 * Walk `color`'s track from `startCell` leaving in direction `d`, marking
 * visited and growing the comp* bounds. Returns -1 for a loop, else the open
 * end packed as cell*4 + exitDir. Identical to search2.ts's.
 */
function walkEval(fb: FastBoard, startCell: number, d: number, color: number): number {
  let cur = startCell
  for (;;) {
    const n = cur + DELTA[d]
    const nv = fb.grid[n]
    if (nv === 0) return cur * 4 + d
    if (n === startCell) return -1
    evalStamp[n * 2 + color] = evalGen
    const x = cellX(n)
    const y = cellY(n)
    if (x < compMinX) compMinX = x
    if (x > compMaxX) compMaxX = x
    if (y < compMinY) compMinY = y
    if (y > compMaxY) compMaxY = y
    d = CELL_OTHER_END[nv * 4 + ((d + 2) & 3)]
    cur = n
  }
}

/** Span bucket offset, shared by the one-open-end and two-open-end line groups. */
function spanBucket(span: number): number {
  if (span <= 3) return 0
  if (span <= 5) return 1
  if (span === 6) return 2
  if (span === 7) return 3
  return 4
}

/** evalWhite's own visited lane; see the note in search2.ts. */
const evalStamp = new Uint16Array(CELL_SPACE * 2) // cell*2 + color
let evalGen = 0

/** Flagged tracks awaiting verification: [exitCellA, exitCellB] pairs. */
const flagged: number[] = []
/** Probe scratch: candidate cells for one track, deduped. */
const probeCells = new Set<number>()

/** Identical to search2.ts's closesInOne — the mechanism this variant keeps. */
function closesInOne(fb: FastBoard, color: number, cellA: number, cellB: number): boolean {
  const cells = probeCells
  cells.clear()
  for (const c of [cellA, cellB]) {
    if (fb.grid[c] === 0) cells.add(c)
    for (let d = 0; d < 4; d++) {
      const n = c + DELTA[d]
      if (fb.grid[n] === 0) cells.add(n)
    }
  }
  const want = color + 1 // FastBoard.make: 1 = W_WINS, 2 = R_WINS
  for (const cell of cells) {
    for (let t = 0; t < 6; t++) {
      const status = fb.make(cell, t)
      if (status === ILLEGAL) continue
      fb.unmake()
      if (status === want) return true
    }
  }
  return false
}

/**
 * Fitted heuristic score of a non-terminal position for White.
 *
 * The bucket boundaries here must stay identical to src/ai/features.ts's, since
 * that is the basis the weights were fitted over — including that separation 0
 * falls in the `d1` bucket (it cannot occur: two same-colored edges facing an
 * empty cell is a forced fill) and that a *blocked* pair is tested before
 * separation, matching `loopThreat` returning 0 there.
 *
 * The threat count keeps the hand eval's meaning exactly: a loop whose ends are
 * one step apart, or a line open at both ends one short of the span. In this
 * parametrisation those are "the d1 bucket fired" and "the line_double bucket
 * fired", so no magnitude comparison is involved.
 */
export function evalWhite(fb: FastBoard): number {
  let score = fb.turn === 0 ? FIT_WEIGHTS[F_TEMPO] : -FIT_WEIGHTS[F_TEMPO]
  const threats = [0, 0]
  evalGen = nextGen(evalStamp, evalGen)
  flagged.length = 0
  const occ = fb.occ
  for (let i = 0, count = fb.occCount; i < count; i++) {
    const cell = occ[i]
    const code = CELL_CODE[fb.grid[cell]]
    for (let color = 0; color < 2; color++) {
      if (evalStamp[cell * 2 + color] === evalGen) continue
      evalStamp[cell * 2 + color] = evalGen
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
      const endA = walkEval(fb, cell, d1, color)
      // A closed loop carries no slot in this basis, exactly as it carries no
      // term in the hand eval.
      if (endA === -1) continue
      const endB = walkEval(fb, cell, d2, color)
      const aCell = endA >>> 2
      const aDir = endA & 3
      const bCell = endB >>> 2
      const bDir = endB & 3
      const eaX = cellX(aCell) + DX[aDir]
      const eaY = cellY(aCell) + DY[aDir]
      const ebX = cellX(bCell) + DX[bDir]
      const ebY = cellY(bCell) + DY[bDir]

      let v = 0
      const dist = Math.abs(eaX - ebX) + Math.abs(eaY - ebY)
      // `blocked` is exactly the condition under which loopThreat returns 0:
      // colinear ends pointing apart, at nonzero separation.
      const blocked = dist !== 0 && aDir === ((bDir + 2) & 3) && DX[aDir] * (ebX - eaX) + DY[aDir] * (ebY - eaY) <= 0
      let converged = false
      if (blocked) v += FIT_WEIGHTS[F_LOOP_BLOCKED]
      else if (dist <= 1) {
        v += FIT_WEIGHTS[F_LOOP_D1]
        converged = true
      } else if (dist === 2) v += FIT_WEIGHTS[F_LOOP_D2]
      else if (dist === 3) v += FIT_WEIGHTS[F_LOOP_D3]
      else v += FIT_WEIGHTS[F_LOOP_FAR] / (dist * dist)

      let lineDouble = false
      for (let axis = 0; axis < 2; axis++) {
        const span = axis === 0 ? compMaxY - compMinY + 1 : compMaxX - compMinX + 1
        const lo = axis === 0 ? compMinY : compMinX
        const hi = axis === 0 ? compMaxY : compMaxX
        const ea = axis === 0 ? eaY : eaX
        const eb = axis === 0 ? ebY : ebX
        const open = (ea < lo || eb < lo ? 1 : 0) + (ea > hi || eb > hi ? 1 : 0)
        if (open === 0) continue
        if (open === 2 && span >= LINE_SPAN - 1) {
          v += FIT_WEIGHTS[F_LINE_DOUBLE]
          lineDouble = true
        } else if (open === 2) v += FIT_WEIGHTS[Math.min(F_LINE2_S3 + spanBucket(span), F_LINE2_S6)]
        else v += FIT_WEIGHTS[F_LINE1_S3 + spanBucket(span)]
      }

      score += color === 0 ? v : -v
      if (converged || lineDouble) {
        threats[color]++
        if (color === fb.turn) flagged.push(cellOf(eaX, eaY), cellOf(ebX, ebY))
      }
    }
  }
  const mover = fb.turn
  for (let i = 0; i < flagged.length; i += 2) {
    if (closesInOne(fb, mover, flagged[i], flagged[i + 1])) {
      return mover === 0 ? WEIGHTS.winInOne : -WEIGHTS.winInOne
    }
  }
  if (threats[0] >= 2) score += FIT_WEIGHTS[F_TWO_THREAT]
  if (threats[1] >= 2) score -= FIT_WEIGHTS[F_TWO_THREAT]
  return score
}

/**
 * Bounded position→evalWhite cache, keyed by the turn-salted 53-bit hash.
 * Open-addressed over typed arrays with the same shape as the TT below: one
 * probe, overwrite on collision. The Map it replaces cost a double-keyed hash
 * lookup on the hottest path in the search and hit a 250k-entry `.clear()`
 * cliff. A collision can only lose an entry, never return the wrong score —
 * the key still has to match exactly.
 */
const EVAL_SLOTS = 1 << 18
const evalKey = new Float64Array(EVAL_SLOTS) // 53-bit hash; 0 = empty slot
const evalVal = new Float64Array(EVAL_SLOTS)

function evalFor(fb: FastBoard, mover: number): number {
  const h = fb.hash()
  const slot = h % EVAL_SLOTS
  let v: number
  if (evalKey[slot] === h) {
    v = evalVal[slot]
  } else {
    v = evalWhite(fb)
    evalKey[slot] = h
    evalVal[slot] = v
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

/** Search ply ceiling: bounds the killer table and the mate-score window. */
const MAX_PLY = 128

/**
 * Above this magnitude a score is a mate score rather than an eval — mates
 * start at `WIN_SCORE - MAX_PLY` = 999872, an order of magnitude clear of the
 * largest eval term (`winInOne`, 500 000).
 */
const MATE_BOUND = WIN_SCORE - MAX_PLY

/**
 * Mate scores are produced as distance from the **root** (`madeScore` returns
 * `WIN_SCORE - (ply + 1)`), but the TT is shared across plies, iterations, moves
 * and whole games, so a root-relative distance is meaningless to whoever probes
 * the entry next. Convert to distance from *this node* on the way in and back on
 * the way out.
 *
 * The cost of not doing this was never a wrong verdict: Trax legality is
 * history-free, so "won for the side to move" is a property of the position
 * alone and survives any mislabelled distance. What it corrupted was preference
 * *among* wins and when chooseMove's decided-break fires — i.e. dithering in an
 * already-won position.
 */
const toTT = (score: number, ply: number): number =>
  score > MATE_BOUND ? score + ply : score < -MATE_BOUND ? score - ply : score

const fromTT = (score: number, ply: number): number =>
  score > MATE_BOUND ? score - ply : score < -MATE_BOUND ? score + ply : score

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

/**
 * Butterfly history, one lane per side to move.
 *
 * A move's *identity* is side-independent in Trax — either player may place any
 * tile anywhere — but its *value* is not, and a single shared table let the two
 * sides overwrite each other's credit. Lanes fix that.
 *
 * Moves are packed as cell*8 + tile, which is far too sparse to index directly
 * (a cell alone runs to 2^20), so they are multiply-shift hashed into a fixed
 * table. A collision merely blurs two moves' credit, which an ordering
 * heuristic can absorb; correctness never depends on it.
 */
const HIST_BITS = 16
const HIST_MASK = (1 << HIST_BITS) - 1
const historyTable = new Int32Array(2 << HIST_BITS)

const historySlot = (side: number, mv: number): number =>
  (side << HIST_BITS) | ((Math.imul(mv, 0x9e3779b1) >>> 15) & HIST_MASK)

interface Ctx {
  fb: FastBoard
  nodes: number
  deadline: number
  maxNodes: number
  /** One reusable move buffer per ply, so recursion never clobbers a live list. */
  movesAtPly: number[][]
  /** Ordering-key scratch, parallel to movesAtPly. */
  keysAtPly: number[][]
  /** Occupied-neighbour counts from moves(), parallel to movesAtPly. */
  constraintsAtPly: number[][]
  /** Two killer moves per ply (packed ints, -1 = empty). */
  killers: Int32Array
}

/**
 * Weight of the occupied-neighbour prior, per neighbour.
 *
 * Deliberately below 1/4, so four occupied neighbours still score under the
 * single smallest history bump (a depth-1 cutoff, worth 1). History is learned
 * from this actual search; the neighbour count is a static guess that a more
 * constrained placement is more forcing. So the prior only ever breaks ties —
 * but that is where it is needed: at a TT miss with cold history, which is
 * every node on the frontier of a fresh iteration, ~76 moves otherwise carry
 * key 0 and get searched in board-Map insertion order.
 */
const CONSTRAINT_PRIOR = 0.2

/**
 * Score moves for the search: TT move, killers for this ply, then history
 * credit broken by how constrained the placement is. Cheap (no child evals) —
 * exactly what make/unmake speed pays for.
 *
 * Only the keys are computed here. Ordering itself is done lazily by
 * `selectNext` as the move loop consumes moves, because at a branching factor
 * of ~76 with a beta cutoff usually inside the first few, sorting all of them
 * is almost entirely wasted work.
 */
function scoreMoves(
  ctx: Ctx,
  moves: number[],
  constraints: number[],
  ttMove: number,
  ply: number,
  side: number,
): number[] {
  const n = moves.length
  const keys = (ctx.keysAtPly[ply] ??= [])
  keys.length = n
  const k0 = ctx.killers[ply * 2]
  const k1 = ctx.killers[ply * 2 + 1]
  for (let i = 0; i < n; i++) {
    const mv = moves[i]
    keys[i] =
      mv === ttMove
        ? Infinity
        : mv === k0
          ? 2e9
          : mv === k1
            ? 1e9
            : historyTable[historySlot(side, mv)] + constraints[i] * CONSTRAINT_PRIOR
  }
  return keys
}

/**
 * Bring the best-keyed move of `moves[i..]` to slot `i`.
 *
 * This permutes `moves` and `keys` together but leaves the parallel
 * `constraints` array alone, which is safe only because it has already been
 * folded into the keys by then and is never read again this node.
 *
 * The block is *rotated* rather than swapped so that ties keep their original
 * relative order — which makes the sequence this produces identical, move for
 * move, to the stable insertion sort it replaces. That matters: ties are the
 * common case (every move with no history credit scores 0), and a swap-based
 * selection would silently reshuffle them and turn a pure speed change into a
 * behavioural one.
 */
function selectNext(moves: number[], keys: number[], i: number, n: number): void {
  let bestJ = i
  let bestK = keys[i]
  for (let j = i + 1; j < n; j++) {
    if (keys[j] > bestK) {
      bestK = keys[j]
      bestJ = j
    }
  }
  if (bestJ === i) return
  const mv = moves[bestJ]
  for (let j = bestJ; j > i; j--) {
    moves[j] = moves[j - 1]
    keys[j] = keys[j - 1]
  }
  moves[i] = mv
  keys[i] = bestK
}

/** Credit a beta cutoff: promote to killer slot 0 and bump history by depth². */
function creditCutoff(ctx: Ctx, mv: number, depth: number, ply: number, side: number): void {
  if (ctx.killers[ply * 2] !== mv) {
    ctx.killers[ply * 2 + 1] = ctx.killers[ply * 2]
    ctx.killers[ply * 2] = mv
  }
  const slot = historySlot(side, mv)
  const bumped = historyTable[slot] + depth * depth
  if (bumped > 1e8) {
    for (let i = 0; i < historyTable.length; i++) historyTable[i] >>= 1
    historyTable[slot] = bumped >> 1
  } else {
    historyTable[slot] = bumped
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
  // Counted (and deadline-checked) *before* the TT probe: the probe's early
  // returns used to be the one way through this function that never touched the
  // clock, so a cutoff-heavy subtree could run straight past the deadline. That
  // costs budget fidelity in the arena and responsiveness in the app.
  bump(ctx)

  const fb = ctx.fb
  const alphaOrig = alpha
  const hash = fb.hash()
  const slot = hash % TT_SLOTS
  const hit = ttKey[slot] === hash
  if (hit && (ttMeta[slot] & 0xff) >= depth) {
    const score = fromTT(ttScore[slot], ply)
    const flag = (ttMeta[slot] >>> 8) & 3
    if (flag === FLAG_EXACT) return score
    if (flag === FLAG_LOWER && score > alpha) alpha = score
    else if (flag === FLAG_UPPER && score < beta) beta = score
    if (alpha >= beta) return score
  }

  const moves = (ctx.movesAtPly[ply] ??= [])
  const constraints = (ctx.constraintsAtPly[ply] ??= [])
  fb.moves(moves, constraints)
  const mover = fb.turn
  // TT move first (legality is still make()-checked, so a hash collision can
  // only cost ordering quality, never correctness), then killers + history.
  const keys = scoreMoves(ctx, moves, constraints, hit ? ttMove[slot] : -1, ply, mover)

  const n = moves.length
  let best = -Infinity
  let bestMove = -1
  let legal = 0
  for (let i = 0; i < n; i++) {
    selectNext(moves, keys, i, n)
    const mv = moves[i]
    const status = fb.make(mv >>> 3, mv & 7)
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
      creditCutoff(ctx, mv, depth, ply, mover)
      break
    }
  }
  if (legal === 0) return -(WIN_SCORE - ply) // no legal move: mover loses

  const flag = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT
  ttStore(hash, depth, toTT(best, ply), flag, bestMove)
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
 *
 * Results go into the caller's `out` as they are settled, rather than being
 * returned at the end, so that a TIMEOUT thrown part-way leaves the prefix that
 * *did* finish in the caller's hands instead of unwinding it away with the
 * stack. See chooseMove for what is then allowed to be done with it.
 */
function searchRoot(ctx: Ctx, moves: number[], depth: number, margin: number, out: RootScore[]): void {
  out.length = 0
  const mover = ctx.fb.turn
  let best = -Infinity
  for (const mv of moves) {
    const alpha = best === -Infinity ? -Infinity : best - margin - 1
    const status = ctx.fb.make(mv >>> 3, mv & 7)
    if (status === ILLEGAL) continue
    const s = madeScore(ctx, status, mover, depth, alpha, Infinity, 0)
    ctx.fb.unmake()
    out.push({ mv, score: s })
    if (s > best) best = s
  }
}

const toMove = (mv: number): Move => ({
  x: cellX(mv >>> 3),
  y: cellY(mv >>> 3),
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
    const status = fb.make(mv >>> 3, mv & 7)
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
    constraintsAtPly: [],
    killers: new Int32Array(MAX_PLY * 2).fill(-1),
  }
  historyTable.fill(0)

  /** The best iteration we are willing to move on. */
  let scores: RootScore[] = []
  /** Root scores of the iteration in flight; a prefix of it if that aborts. */
  const iteration: RootScore[] = []
  let completedDepth = 0
  for (let depth = 1; depth <= limits.maxDepth; depth++) {
    let aborted = false
    try {
      searchRoot(ctx, rootMoves, depth, margin, iteration)
    } catch (e) {
      if (e !== TIMEOUT) throw e
      while (fb.depth() > 0) fb.unmake() // unwind the aborted line
      aborted = true
    }

    if (aborted) {
      // The aborted iteration routinely holds half the think time, and its
      // root moves are searched best-first, so its completed prefix is the
      // *most promising* moves scored a ply deeper than anything below.
      // Throwing that away — which is what this used to do — is expensive.
      //
      // Taking it is sound because rootMoves is re-sorted best-first after
      // every completed iteration: the previous best is element 0 and so is
      // always inside the prefix, meaning "best of the prefix at depth d" can
      // never be worse than "the previous iteration's choice, re-judged at
      // depth d". Below two settled moves there is nothing to compare, so the
      // previous iteration is kept whole instead.
      //
      // The decided-break deliberately does not run here: outside the first
      // entry these scores are fail-soft upper bounds (root alpha trails at
      // `best - margin - 1`), so they are not safe to read as verdicts.
      if (iteration.length >= 2) scores = iteration.slice()
      break
    }

    scores = iteration.slice()
    completedDepth = depth
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
  // `depth` stays the last *fully* completed iteration even when the move came
  // from an accepted prefix: it is what the benchmarks read to tell a real depth
  // gain from a bookkeeping one, and counting a prefix as a whole ply would
  // quietly inflate it.
  return { move: toMove(pick.mv), score: pick.score, depth: completedDepth, nodes: ctx.nodes }
}
