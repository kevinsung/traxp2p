import { neighbor, opposite, parseKey } from '../game/board'
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
  /** A span-(LINE_SPAN-1) track open at both ends: completes at either end. */
  lineDouble: 10_000,
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
 * Line threat of one track. Only ends that can actually extend the span —
 * exiting beyond the track's extreme row/column on that axis — count; a
 * capped end (the track turned sideways at its extreme) has no line
 * potential there. A track one short of LINE_SPAN that is open at BOTH ends
 * completes at either end, so the opponent cannot block both: score it as
 * practically decided (lineDouble).
 */
function linePotential(comp: ComponentInfo): number {
  if (!comp.exits) return 0
  const [ea, eb] = comp.exits
  const axis = (span: number, openA: boolean, openB: boolean): number => {
    const open = (openA ? 1 : 0) + (openB ? 1 : 0)
    if (open === 0) return 0
    if (open === 2 && span >= LINE_SPAN - 1) return WEIGHTS.lineDouble
    const mult = open === 2 ? 1.5 : 0.75
    return WEIGHTS.line * mult * (Math.min(span, LINE_SPAN) / LINE_SPAN) ** 2
  }
  const vert = axis(comp.spanY, ea.y < comp.minY || eb.y < comp.minY, ea.y > comp.maxY || eb.y > comp.maxY)
  const horiz = axis(comp.spanX, ea.x < comp.minX || eb.x < comp.minX, ea.x > comp.maxX || eb.x > comp.maxX)
  return Math.max(vert, horiz)
}

/**
 * Heuristic score of a non-terminal position for `forColor`, following Trax
 * strategy literature: attacking potential is tracks whose open ends converge
 * (loop threats, corners) plus tracks extending toward a LINE_SPAN line.
 * Antisymmetric: evaluate(s, c) === -evaluate(s, otherColor(c)).
 */
export function evaluate(state: GameState, forColor: Color): number {
  let score = state.turn === forColor ? WEIGHTS.tempo : -WEIGHTS.tempo
  for (const comp of components(state.board)) {
    const sign = comp.color === forColor ? 1 : -1
    let v = 0
    if (comp.exits) v += loopThreat(comp.exits, comp.dirs!)
    v += linePotential(comp)
    score += sign * v
  }
  return score
}
