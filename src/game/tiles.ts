import type { Color, Dir, TileKind } from './types'

export const ALL_TILES: readonly TileKind[] = ['WRWR', 'RWRW', 'WWRR', 'RWWR', 'RRWW', 'WRRW']

/**
 * The only two distinct first moves (all six tiles reduce to these two under
 * rotation on an empty board): a cross ("@0+") and a curve ("@0/").
 */
export const FIRST_TILES: readonly TileKind[] = ['WRWR', 'RRWW']

export const edgeColor = (t: TileKind, d: Dir): Color => t[d] as Color

export const isCross = (t: TileKind): boolean => t === 'WRWR' || t === 'RWRW'

/** The other edge of `t` carrying the same color as edge `d` (its track exit). */
export function otherEnd(t: TileKind, d: Dir): Dir {
  const c = t[d]
  for (const e of [0, 1, 2, 3] as const) {
    if (e !== d && t[e] === c) return e
  }
  throw new Error(`invalid tile ${t}`)
}

/** The tile with the given N,E,S,W edge colors, or null if no tile has them. */
export function tileFromEdges(edges: readonly [Color, Color, Color, Color]): TileKind | null {
  const s = edges.join('')
  return (ALL_TILES as readonly string[]).includes(s) ? (s as TileKind) : null
}
