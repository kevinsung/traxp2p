import { DIRS, key, neighbor, opposite, parseKey } from '../game/board'
import { applyMove } from '../game/engine'
import { ALL_TILES } from '../game/tiles'
import { LINE_SPAN, trace } from '../game/wins'
import type { Board, Color, Coord, Dir, GameState } from '../game/types'

/** Base score of a won position; search subtracts ply to prefer faster wins. */
export const WIN_SCORE = 1_000_000

export const WEIGHTS = {
  /** Value of a track whose open ends have fully converged (loop threat). */
  loop: 100,
  /** Value of a track spanning the full LINE_SPAN (line threat). */
  line: 60,
  /** Bonus for having the move. */
  tempo: 10,
  /**
   * A span-(LINE_SPAN-1) track open at both ends: completes at either end.
   *
   * The *condition* is `isLineDouble`, which no longer reads this value — see
   * there. That separation is what makes the magnitude re-priceable at all.
   */
  lineDouble: 10_000,
  /**
   * Two threats one move from completing: the opponent cannot block both.
   *
   * **This number appears not to matter, in either direction.** Outcome-fitted
   * regression over 230k self-play positions prices the term at **66 points**
   * (docs/ai-arena.md, 2026-07-30), i.e. claims the eval overprices it ~150x.
   * Taking both cliffs down to 100 measured **+0.70pt over 4000 paired games**
   * (95% CI −0.18 to +1.58) and dead level at equal work, so it was not promoted.
   * The two earlier sweeps went *up*, to 50 000 and 500 000, and also read level.
   *
   * Three measurements, three directions, all level: what this cliff is doing is
   * *detecting* the position, and the score it assigns is nearly free. Do not
   * spend another gate on the value.
   */
  loopDouble: 10_000,
  /**
   * The side to move has a track that a single legal move really does close.
   * Decisive — they simply play it — but deliberately far below WIN_SCORE, so
   * a genuine mate score still outranks it and search keeps preferring the
   * shorter win. See `closesInOne`.
   */
  winInOne: 500_000,
}

/** One color's connected track: its cells, extent, and where its ends point. */
export interface ComponentInfo {
  color: Color
  cells: number
  spanX: number
  spanY: number
  minX: number
  maxX: number
  minY: number
  maxY: number
  /** Empty cells the two open ends point into; null for a closed loop. */
  exits: [Coord, Coord] | null
  /** Directions the two open ends leave their tiles in; null for a loop. */
  dirs: [Dir, Dir] | null
}

export function components(board: Board): ComponentInfo[] {
  const visited = new Set<string>() // `${cellKey}|${color}`, shared across traces
  const out: ComponentInfo[] = []
  for (const k of board.keys()) {
    const start = parseKey(k)
    for (const color of ['W', 'R'] as const) {
      if (visited.has(`${k}|${color}`)) continue
      const trk = trace(board, start.x, start.y, color, visited)
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const ck of trk.cells) {
        const { x, y } = parseKey(ck)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const ends = trk.loop ? null : trk.ends!
      out.push({
        color,
        cells: trk.cells.length,
        spanX: maxX - minX + 1,
        spanY: maxY - minY + 1,
        minX,
        maxX,
        minY,
        maxY,
        exits: ends && [neighbor(ends[0].x, ends[0].y, ends[0].d), neighbor(ends[1].x, ends[1].y, ends[1].d)],
        dirs: ends && [ends[0].d, ends[1].d],
      })
    }
  }
  return out
}

/**
 * Attacking potential of one track, per Trax strategy: converging open ends
 * are corners / loop threats. Exit distance 1 means one move closes the loop
 * (directly or via a forced fill); a lone curve's corner scores loop/4.
 * Distance 0 cannot occur: that cell would already have been force-filled.
 * Ends on a single axis pointing apart (a straight) have no loop potential —
 * such tracks are valued by the line term instead.
 */
function loopThreat(exits: [Coord, Coord], dirs: [Dir, Dir]): number {
  const [ea, eb] = exits
  const dist = Math.abs(ea.x - eb.x) + Math.abs(ea.y - eb.y)
  if (dist === 0) return WEIGHTS.loop
  if (dirs[0] === opposite(dirs[1])) {
    const va = neighbor(0, 0, dirs[0])
    // Symmetric for both ends: va·(eb−ea) equals (−va)·(ea−eb).
    if (va.x * (eb.x - ea.x) + va.y * (eb.y - ea.y) <= 0) return 0
  }
  return WEIGHTS.loop / (dist * dist)
}

/**
 * A track one short of LINE_SPAN and open at BOTH ends on one axis: it completes
 * at either end, so the opponent cannot block both.
 *
 * This is the *condition*, deliberately separated from `WEIGHTS.lineDouble`,
 * which is its score. The threat count below used to test `line >= lineDouble`,
 * which was the same question only because the score was larger than every other
 * term — so the score could not be re-priced without silently changing what
 * counts as a threat, and re-pricing it is exactly what the 2026-07-30 round
 * does. Detection and magnitude are now independent.
 */
const isLineDouble = (span: number, openA: boolean, openB: boolean): boolean =>
  openA && openB && span >= LINE_SPAN - 1

/** A track's line potential, and whether it is one move from a line either way. */
interface LineInfo {
  score: number
  double: boolean
}

/**
 * Line threat of one track. Only ends that can actually extend the span —
 * exiting beyond the track's extreme row/column on that axis — count; a
 * capped end (the track turned sideways at its extreme) has no line
 * potential there.
 */
function linePotential(comp: ComponentInfo): LineInfo {
  if (!comp.exits) return { score: 0, double: false }
  const [ea, eb] = comp.exits
  const axis = (span: number, openA: boolean, openB: boolean): number => {
    const open = (openA ? 1 : 0) + (openB ? 1 : 0)
    if (open === 0) return 0
    if (isLineDouble(span, openA, openB)) return WEIGHTS.lineDouble
    const mult = open === 2 ? 1.5 : 0.75
    return WEIGHTS.line * mult * (Math.min(span, LINE_SPAN) / LINE_SPAN) ** 2
  }
  const vLo = ea.y < comp.minY || eb.y < comp.minY
  const vHi = ea.y > comp.maxY || eb.y > comp.maxY
  const hLo = ea.x < comp.minX || eb.x < comp.minX
  const hHi = ea.x > comp.maxX || eb.x > comp.maxX
  return {
    score: Math.max(axis(comp.spanY, vLo, vHi), axis(comp.spanX, hLo, hHi)),
    double: isLineDouble(comp.spanY, vLo, vHi) || isLineDouble(comp.spanX, hLo, hHi),
  }
}

/**
 * Can `color`'s track, whose open ends point into `exits`, be completed by a
 * single legal move? Answered by playing the candidate moves rather than by
 * measuring the gap, so a forced-fill cascade that closes the loop counts and a
 * pair of ends that merely *look* close does not.
 *
 * loopThreat's distance test is the candidate generator for this: measured over
 * 6628 positions from games lost to trax-analyst it has 91% recall but only 22%
 * precision, and the two-threat cliff it feeds is wrong 64% of the times it
 * fires. Playing the move settles it exactly (100% precision, 85% recall as a
 * win-in-1 detector).
 *
 * Candidates are the two exit cells plus their neighbors: of the winning moves
 * in that corpus, 79% land on an exit cell and 21% land adjacent to one.
 *
 * Worth +2.0pt against trax-analyst (80.9% vs 78.9%, 4000 games each, 4 seeds,
 * --nodes 20000, CI 0.3 to 3.8), and level in self-play against the build
 * without it (51.8% over 2000 games). It roughly doubles the cost of an eval,
 * but still comes out ahead at a fixed time budget. Mechanically it does what
 * it was built to do: among the games still lost, positions where the analyst
 * had two winning replies at once fell 41% (107 -> 63).
 *
 * Independent of whose turn it is — Trax legality is history-free and either
 * player may place any tile — so this depends only on the position.
 */
function closesInOne(state: GameState, color: Color, exits: [Coord, Coord]): boolean {
  const cells: Coord[] = []
  const seen = new Set<string>()
  for (const e of exits) {
    for (const c of [e, ...DIRS.map((d) => neighbor(e.x, e.y, d))]) {
      const k = key(c.x, c.y)
      if (state.board.has(k) || seen.has(k)) continue
      seen.add(k)
      cells.push(c)
    }
  }
  for (const c of cells) {
    for (const tile of ALL_TILES) {
      const out = applyMove(state, { x: c.x, y: c.y, tile })
      if (out.ok && out.state.result?.winner === color) return true
    }
  }
  return false
}

/**
 * Heuristic score of a non-terminal position for `forColor`, following Trax
 * strategy literature: attacking potential is tracks whose open ends converge
 * (loop threats, corners) plus tracks extending toward a LINE_SPAN line.
 *
 * On top of the per-track terms, a side holding two threats that each complete
 * in one move scores near-decisive: the opponent gets one move and cannot block
 * both. This is the loop analog of linePotential's lineDouble cliff, and it
 * counts loop and line threats together, so a loop+line fork also fires.
 * `loopThreat >= WEIGHTS.loop` is exactly "ends one step apart" — the looser
 * "two steps apart" reading measurably weakened the AI, so it stays tight.
 *
 * That geometric count is imprecise, though (22% of the tracks it flags can
 * actually be closed), so it is used twice over: as the soft positional term
 * above, and as the candidate list for an exact check. Any flagged track
 * belonging to the side *to move* is verified with `closesInOne`, and a
 * verified one is simply a win — they have the move. This is what lets a leaf
 * see one ply further on the motif that decides almost every loss.
 *
 * Antisymmetric: evaluate(s, c) === -evaluate(s, otherColor(c)). Both the
 * threat counts and the closability check depend only on the position, never
 * on `forColor`.
 */
export function evaluate(state: GameState, forColor: Color): number {
  let score = state.turn === forColor ? WEIGHTS.tempo : -WEIGHTS.tempo
  let threatsFor = 0
  let threatsAgainst = 0
  const moverThreats: Array<[Coord, Coord]> = []
  for (const comp of components(state.board)) {
    const sign = comp.color === forColor ? 1 : -1
    const loop = comp.exits ? loopThreat(comp.exits, comp.dirs!) : 0
    const line = linePotential(comp)
    if (loop >= WEIGHTS.loop || line.double) {
      if (sign === 1) threatsFor++
      else threatsAgainst++
      if (comp.color === state.turn) moverThreats.push(comp.exits!)
    }
    score += sign * (loop + line.score)
  }
  for (const exits of moverThreats) {
    if (closesInOne(state, state.turn, exits)) {
      return state.turn === forColor ? WEIGHTS.winInOne : -WEIGHTS.winInOne
    }
  }
  if (threatsFor >= 2) score += WEIGHTS.loopDouble
  if (threatsAgainst >= 2) score -= WEIGHTS.loopDouble
  return score
}
