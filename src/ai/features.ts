import { LINE_SPAN } from '../game/wins'
import { WEIGHTS } from './eval'
import {
  CELL_CODE,
  CELL_OTHER_END,
  CELL_SPACE,
  cellOf,
  cellX,
  cellY,
  DELTA,
  DX,
  DY,
  FastBoard,
  ILLEGAL,
  nextGen,
} from './fastboard'

/**
 * Feature extraction for **pricing** evaluation terms, not for playing.
 *
 * The instrument this exists for: a candidate eval term is scored by fitting
 * weights to self-play *outcomes* (scripts/gen-selfplay.ts → scripts/train-eval.ts),
 * which puts a number on it in eval points before anyone spends a multi-hour
 * paired gate finding out. Two of the three rejected rounds in
 * docs/ai-arena.md were magnitude changes to signals the eval already had, and
 * that is exactly what a fit reports for free.
 *
 * **The basis nests the current eval exactly.** The first four slots are the
 * hand eval's own components, weighted by `HAND`, so
 *
 *     HAND · extractCore(fb) === evalWhite(fb)
 *
 * on every position where the mover has no verified win in one (see below).
 * tests/features.test.ts asserts that identity, which is what keeps this file
 * from drifting away from `search2.ts:evalWhite` the way a transcribed weight
 * vector would. It also means every *other* slot's fitted weight reads as an
 * increment over what the eval already does — the interpretation pricing needs —
 * and that the ±10 000 `loopDouble` cliff gets priced for free, since
 * `two_threat` is a slot rather than a constant.
 *
 * **Positions where the mover has a verified win in one are outside the
 * corpus.** They are tactically settled — `evalWhite` returns ±`winInOne` and
 * the search wins them anyway — and excluding them is also what makes the
 * nesting identity exact, because that path *replaces* the hand score rather
 * than adding to it. `extractVerified` reports the verdict so callers can skip.
 *
 * Every slot is **antisymmetric**: swap both tile colors and the side to move
 * and each one negates. That is what makes negamax over any fitted weight
 * vector sound, and a sign slip in a new slot has no other guard — see the
 * antisymmetry case in tests/features.test.ts.
 *
 * Offline only. It allocates a `CELL_SPACE`-wide stamp lane and the verified
 * slots play moves on the board; nothing in the app imports this.
 */

// --- Slots -------------------------------------------------------------------

/** +1 when White has the move, −1 when Red does. Hand weight: `WEIGHTS.tempo`. */
export const F_TEMPO = 0
/** Σ over components of `sign × loopThreat`. Hand weight: 1 (it is already points). */
export const F_LOOP_SUM = 1
/** Σ over components of `sign × max(vert, horiz)` line potential. Hand weight: 1. */
export const F_LINE_MAX = 2
/** `[threatsW >= 2] − [threatsR >= 2]`. Hand weight: `WEIGHTS.loopDouble`. */
export const F_TWO_THREAT = 3

/** G2: signed `max(0, threats − 1)` — threats *beyond* the first. */
export const F_FORK_COUNT = 4

/** G3: separation buckets, a reparametrisation of `loop_sum`. */
export const F_LOOP_D1 = 5
export const F_LOOP_D2 = 6
export const F_LOOP_D3 = 7
/** `sign / dist²` for separation ≥ 4, so its weight is comparable to `WEIGHTS.loop`. */
export const F_LOOP_FAR = 8
/** Colinear ends pointing apart: no loop potential at all (`loopThreat` returns 0). */
export const F_LOOP_BLOCKED = 9

/** G4: per-axis span × open-ends buckets, a reparametrisation of `line_max`. */
export const F_LINE1_S3 = 10
export const F_LINE1_S45 = 11
export const F_LINE1_S6 = 12
export const F_LINE1_S7 = 13
export const F_LINE1_S8 = 14
export const F_LINE2_S3 = 15
export const F_LINE2_S45 = 16
export const F_LINE2_S6 = 17
/** Both ends extending at span ≥ LINE_SPAN−1: completes at either end. */
export const F_LINE_DOUBLE = 18

/** G5: signed component count — fragmentation, with no hand counterpart. */
export const F_TRACKS = 19

/** Everything up to here is free at runtime; the eval already walks the tracks. */
export const CHEAP_COUNT = 20

/**
 * G1: the *waiter's* verified threats — the side **not** to move. Signed by the
 * waiter's color, so a threat White holds while Red is to move is +.
 *
 * Expensive: this is `closesInOne` for both sides, the change that cost 18% of
 * the node rate and gated level on 2026-07-29. Offline it costs nothing, which
 * is the point of pricing it here before deciding.
 */
export const F_WAITER_BLOCKABLE = 20
/** Waiter threat whose closing cells are ≥3 apart — one placement cannot answer both. */
export const F_WAITER_OPEN = 21

export const FEATURE_COUNT = 22

/** Names parallel to the slots above, for training diagnostics. */
export const FEATURE_NAMES: readonly string[] = [
  'tempo',
  'loop_sum',
  'line_max',
  'two_threat',
  'fork_count',
  'loop_d1',
  'loop_d2',
  'loop_d3',
  'loop_far',
  'loop_blocked',
  'line1_s3',
  'line1_s45',
  'line1_s6',
  'line1_s7',
  'line1_s8',
  'line2_s3',
  'line2_s45',
  'line2_s6',
  'line_double',
  'tracks',
  'waiter_blockable',
  'waiter_open',
]

/**
 * The shipped evaluation, as a weight vector over this basis:
 * `HAND · extractCore(fb) === evalWhite(fb)`. Candidate slots are 0, so a
 * fitted weight on one of them is a pure increment over today's eval.
 */
export const HAND: Float64Array = (() => {
  const w = new Float64Array(FEATURE_COUNT)
  w[F_TEMPO] = WEIGHTS.tempo
  w[F_LOOP_SUM] = 1
  w[F_LINE_MAX] = 1
  w[F_TWO_THREAT] = WEIGHTS.loopDouble
  return w
})()

/** The four slots the hand eval spends its weight on; every fit starts here. */
export const CORE_SLOTS: readonly number[] = [F_TEMPO, F_LOOP_SUM, F_LINE_MAX, F_TWO_THREAT]

/**
 * Candidate groups, priced one at a time by leave-one-in ablation rather than
 * in one joint fit: G3's buckets are a reparametrisation of `loop_sum` and G4's
 * of `line_max`, so a joint fit would be collinear and an individual weight
 * there would mean very little. `replaces` names the core slot a group stands
 * in for and which must therefore be dropped while it is fitted — for G4 that
 * is not optional, since `max` is not linear in the per-axis buckets.
 */
export interface FeatureGroup {
  /** Short name the trainer's CLI selects by (`--fit G2,G3`). */
  id: string
  name: string
  slots: readonly number[]
  /** Core slots to drop while this group is fitted. */
  replaces: readonly number[]
  /** `free` costs the runtime nothing; `verified` needs both-side `closesInOne`. */
  cost: 'free' | 'verified'
}

export const GROUPS: readonly FeatureGroup[] = [
  { id: 'G1', name: 'waiter asymmetry', slots: [F_WAITER_BLOCKABLE, F_WAITER_OPEN], replaces: [], cost: 'verified' },
  { id: 'G2', name: 'cliff magnitude', slots: [F_FORK_COUNT], replaces: [], cost: 'free' },
  {
    id: 'G3',
    name: 'separation buckets',
    slots: [F_LOOP_D1, F_LOOP_D2, F_LOOP_D3, F_LOOP_FAR, F_LOOP_BLOCKED],
    replaces: [F_LOOP_SUM],
    cost: 'free',
  },
  {
    id: 'G4',
    name: 'line aggregation',
    slots: [F_LINE1_S3, F_LINE1_S45, F_LINE1_S6, F_LINE1_S7, F_LINE1_S8, F_LINE2_S3, F_LINE2_S45, F_LINE2_S6, F_LINE_DOUBLE],
    replaces: [F_LINE_MAX],
    cost: 'free',
  },
  { id: 'G5', name: 'fragmentation', slots: [F_TRACKS], replaces: [], cost: 'free' },
]

// --- Track walk (structure mirrors search2.ts:evalWhite) ----------------------

// Component bounds tracked by walkFeat (module scratch; extraction is single-threaded).
let compMinX = 0
let compMaxX = 0
let compMinY = 0
let compMaxY = 0

/**
 * Its **own** generation-stamped visited lane, deliberately not `evalWhite`'s
 * and not FastBoard's: the verified slots call `make()` from inside extraction,
 * and a shared generation counter would be bumped out from under this walk.
 */
const featStamp = new Uint16Array(CELL_SPACE * 2) // cell*2 + color
let featGen = 0

/**
 * Walk `color`'s track from `startCell` leaving in direction `d`, marking
 * visited and growing the comp* bounds. Returns -1 for a loop, else the open
 * end packed as cell*4 + exitDir. Same walk as `search2.ts:walkEval`.
 */
function walkFeat(fb: FastBoard, startCell: number, d: number, color: number): number {
  let cur = startCell
  for (;;) {
    const n = cur + DELTA[d]
    const nv = fb.grid[n]
    if (nv === 0) return cur * 4 + d
    if (n === startCell) return -1
    featStamp[n * 2 + color] = featGen
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

/**
 * Byte-for-byte the loop term of `search2.ts:loopThreat`. Duplicated rather
 * than imported (it is private there) *because* the identity test compares the
 * two: if this drifts, the test fails, which is the whole guard.
 */
function loopThreat(eaX: number, eaY: number, ebX: number, ebY: number, dA: number, dB: number): number {
  const dist = Math.abs(eaX - ebX) + Math.abs(eaY - ebY)
  if (dist === 0) return WEIGHTS.loop
  if (dA === ((dB + 2) & 3)) {
    if (DX[dA] * (ebX - eaX) + DY[dA] * (ebY - eaY) <= 0) return 0
  }
  return WEIGHTS.loop / (dist * dist)
}

/** Byte-for-byte `search2.ts:axisPotential`. */
function axisPotential(span: number, openA: boolean, openB: boolean): number {
  const open = (openA ? 1 : 0) + (openB ? 1 : 0)
  if (open === 0) return 0
  if (open === 2 && span >= LINE_SPAN - 1) return WEIGHTS.lineDouble
  const mult = open === 2 ? 1.5 : 0.75
  return WEIGHTS.line * mult * (Math.min(span, LINE_SPAN) / LINE_SPAN) ** 2
}

/** Bucket offset by span, shared by the one-open-end and two-open-end groups. */
function spanBucket(span: number): number {
  if (span <= 3) return 0
  if (span <= 5) return 1
  if (span === 6) return 2
  if (span === 7) return 3
  return 4
}

/**
 * Flagged tracks awaiting verification: `[color, exitCellA, exitCellB]` triples,
 * filled by `extractCore` and consumed by `extractVerified`. Same two-phase
 * shape `evalWhite` uses, and for the same reason: verification mutates the
 * board, so it cannot run inside the loop that is iterating it.
 */
const flagged: number[] = []

// --- Cheap slots -------------------------------------------------------------

/**
 * Fill slots `[0, CHEAP_COUNT)` of `out` — the four nested core slots plus
 * every candidate that is free at runtime. `out` must have `FEATURE_COUNT`
 * entries; the verified slots are left at 0.
 */
export function extractCore(fb: FastBoard, out: Float64Array): void {
  out.fill(0)
  out[F_TEMPO] = fb.turn === 0 ? 1 : -1
  const threats = [0, 0]
  featGen = nextGen(featStamp, featGen)
  flagged.length = 0

  const occ = fb.occ
  for (let i = 0, count = fb.occCount; i < count; i++) {
    const cell = occ[i]
    const code = CELL_CODE[fb.grid[cell]]
    for (let color = 0; color < 2; color++) {
      if (featStamp[cell * 2 + color] === featGen) continue
      featStamp[cell * 2 + color] = featGen
      const sign = color === 0 ? 1 : -1
      out[F_TRACKS] += sign
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
      const endA = walkFeat(fb, cell, d1, color)
      // A closed loop scores nothing, exactly as in the hand eval (it is
      // terminal anyway and never reached by an eval in a live search) — but it
      // is still a component, so `tracks` above has already counted it.
      if (endA === -1) continue
      const endB = walkFeat(fb, cell, d2, color)
      const aCell = endA >>> 2
      const aDir = endA & 3
      const bCell = endB >>> 2
      const bDir = endB & 3
      const eaX = cellX(aCell) + DX[aDir]
      const eaY = cellY(aCell) + DY[aDir]
      const ebX = cellX(bCell) + DX[bDir]
      const ebY = cellY(bCell) + DY[bDir]

      const loop = loopThreat(eaX, eaY, ebX, ebY, aDir, bDir)
      out[F_LOOP_SUM] += sign * loop

      // G3: the same geometry, bucketed. `loop_sum` above is the hand eval's
      // 100/dist² collapse of exactly this; the buckets let the fit price each
      // separation on its own. Separation 0 cannot occur (two same-colored
      // edges facing an empty cell is a forced fill, so the cascade has already
      // filled it — which also makes `loopThreat`'s `dist === 0` branch dead
      // code in both eval.ts and search2.ts), so d1 owns `dist <= 1`.
      const dist = Math.abs(eaX - ebX) + Math.abs(eaY - ebY)
      if (loop === 0) out[F_LOOP_BLOCKED] += sign
      else if (dist <= 1) out[F_LOOP_D1] += sign
      else if (dist === 2) out[F_LOOP_D2] += sign
      else if (dist === 3) out[F_LOOP_D3] += sign
      else out[F_LOOP_FAR] += sign / (dist * dist)

      const vert = axisPotential(compMaxY - compMinY + 1, eaY < compMinY || ebY < compMinY, eaY > compMaxY || ebY > compMaxY)
      const horiz = axisPotential(compMaxX - compMinX + 1, eaX < compMinX || ebX < compMinX, eaX > compMaxX || ebX > compMaxX)
      const line = Math.max(vert, horiz)
      out[F_LINE_MAX] += sign * line

      // G4: per-axis buckets, summed over both axes. The hand eval keeps only
      // the larger axis, which is not linear in these, so the two cannot
      // coexist in one fit — see GROUPS.
      for (let axis = 0; axis < 2; axis++) {
        const span = axis === 0 ? compMaxY - compMinY + 1 : compMaxX - compMinX + 1
        const lo = axis === 0 ? compMinY : compMinX
        const hi = axis === 0 ? compMaxY : compMaxX
        const ea = axis === 0 ? eaY : eaX
        const eb = axis === 0 ? ebY : ebX
        const open = (ea < lo || eb < lo ? 1 : 0) + (ea > hi || eb > hi ? 1 : 0)
        if (open === 0) continue
        if (open === 2 && span >= LINE_SPAN - 1) out[F_LINE_DOUBLE] += sign
        else if (open === 2) out[F_LINE2_S3 + Math.min(spanBucket(span), 2)] += sign
        else out[F_LINE1_S3 + spanBucket(span)] += sign
      }

      if (loop >= WEIGHTS.loop || line >= WEIGHTS.lineDouble) {
        threats[color]++
        flagged.push(color, cellOf(eaX, eaY), cellOf(ebX, ebY))
      }
    }
  }

  if (threats[0] >= 2) out[F_TWO_THREAT] += 1
  if (threats[1] >= 2) out[F_TWO_THREAT] -= 1
  // G2: the same count without the cliff, so the fit can price the ±10 000.
  out[F_FORK_COUNT] = Math.max(0, threats[0] - 1) - Math.max(0, threats[1] - 1)
}

// --- Verified slots (offline only) -------------------------------------------

/** Probe scratch: the candidate cells for one track, deduped. */
const probeCells = new Set<number>()
/** Closing cells found for one track. */
const closing: number[] = []

/**
 * Which of a flagged track's candidate cells actually close it in one legal
 * move, into `closing`. The enumerating form of `search2.ts:closesInOne` —
 * that one returns on the first hit and its early return is load-bearing on the
 * hot path, so this variant lives here and the hot one is left alone.
 *
 * Candidates are the two exit cells plus their empty neighbours, the same set
 * measured at 100% precision / 85% recall as a win-in-1 detector.
 */
function closingCells(fb: FastBoard, color: number, cellA: number, cellB: number): number[] {
  closing.length = 0
  probeCells.clear()
  for (const c of [cellA, cellB]) {
    if (fb.grid[c] === 0) probeCells.add(c)
    for (let d = 0; d < 4; d++) {
      const n = c + DELTA[d]
      if (fb.grid[n] === 0) probeCells.add(n)
    }
  }
  const want = color + 1 // FastBoard.make: 1 = W_WINS, 2 = R_WINS
  for (const cell of probeCells) {
    for (let t = 0; t < 6; t++) {
      const status = fb.make(cell, t)
      if (status === ILLEGAL) continue
      fb.unmake()
      if (status === want) {
        closing.push(cell)
        break
      }
    }
  }
  return closing
}

/** Largest Manhattan separation between any two of `cells`. */
function maxSeparation(cells: readonly number[]): number {
  let best = 0
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const d = Math.abs(cellX(cells[i]) - cellX(cells[j])) + Math.abs(cellY(cells[i]) - cellY(cells[j]))
      if (d > best) best = d
    }
  }
  return best
}

export interface VerifiedInfo {
  /**
   * The side to move has a track a single legal move really closes, so
   * `evalWhite` returns ±`winInOne` here and the position is outside the
   * corpus. Callers must skip it: the nesting identity does not hold, because
   * that path replaces the hand score rather than adding to it.
   */
  moverWins: boolean
}

/**
 * Fill every slot of `out`, cheap and verified. Runs `extractCore` itself, so a
 * caller never has to remember the ordering the shared `flagged` list implies.
 *
 * Offline only: it plays and unplays moves for both sides' flagged tracks,
 * which is roughly the cost that gated level in the 2026-07-29 round.
 */
export function extractVerified(fb: FastBoard, out: Float64Array): VerifiedInfo {
  extractCore(fb, out)
  const mover = fb.turn
  const waiter = mover ^ 1
  const waiterSign = waiter === 0 ? 1 : -1
  let moverWins = false
  for (let i = 0; i < flagged.length; i += 3) {
    const color = flagged[i]
    const cells = closingCells(fb, color, flagged[i + 1], flagged[i + 2])
    if (cells.length === 0) continue
    if (color === mover) {
      moverWins = true
      continue
    }
    // The separation is the entire signal, and its threshold is derivable
    // rather than tuned: a placement answers a closing cell by occupying it or
    // by fixing an edge beside it, so one move can answer two only within
    // distance 2. Measured 94.3% precise at >= 3 (docs/ai-arena.md, 2026-07-29).
    if (maxSeparation(cells) >= 3) out[F_WAITER_OPEN] += waiterSign
    else out[F_WAITER_BLOCKABLE] += waiterSign
  }
  return { moverWins }
}

/** Scratch vector for callers that want only the flagged list, not the features. */
const scratch = new Float64Array(FEATURE_COUNT)

/**
 * The waiter's verified threats, as one array of closing cells each — the raw
 * material G1's two slots bucket, exposed so candidate fork predicates can be
 * screened against ground truth (scripts/screen-fork.ts) without each one
 * re-deriving the enumeration. Offline only.
 *
 * Cells are packed cell indices; use `cellX`/`cellY` for geometry.
 */
export function waiterThreats(fb: FastBoard, out: number[][]): void {
  out.length = 0
  extractCore(fb, scratch)
  const waiter = fb.turn ^ 1
  for (let i = 0; i < flagged.length; i += 3) {
    if (flagged[i] !== waiter) continue
    const cells = closingCells(fb, waiter, flagged[i + 1], flagged[i + 2])
    if (cells.length > 0) out.push([...cells])
  }
}

/** Dot product of a weight vector with a feature vector. */
export function dot(w: Float64Array, f: Float64Array): number {
  let z = 0
  for (let j = 0; j < FEATURE_COUNT; j++) z += w[j] * f[j]
  return z
}
