import { key, parseKey } from '../game/board'
import { ALL_TILES, FIRST_TILES, otherEnd } from '../game/tiles'
import { LINE_SPAN } from '../game/wins'
import type { Board, Dir, GameState } from '../game/types'

/**
 * Mutable, integer-encoded search board with make/unmake. The immutable
 * engine (src/game/engine.ts) stays the reference oracle for correctness —
 * this class exists purely so search can expand nodes without copying the
 * board Map, recomputing notation, or re-hashing from scratch. Differential
 * tests (tests/fastboard.test.ts) hold it to the engine's exact behavior.
 */

// --- Coordinates: 12-bit x/y fields packed into one non-negative int -------

export const SHIFT = 12
const MASK = 0xfff
const CENTER = 2048
/** make() throws beyond this rather than silently wrapping the 12-bit field. */
const COORD_LIMIT = 2047

export const cellOf = (x: number, y: number): number => ((x + CENTER) << SHIFT) | (y + CENTER)
export const cellX = (cell: number): number => (cell >>> SHIFT) - CENTER
export const cellY = (cell: number): number => (cell & MASK) - CENTER

/** Cell offset per direction, in board.ts DIR order (N, E, S, W). */
export const DELTA: readonly number[] = [-1, 1 << SHIFT, 1, -(1 << SHIFT)]
/** Coordinate offsets per direction, matching DELTA. */
export const DX: readonly number[] = [0, 1, 0, -1]
export const DY: readonly number[] = [-1, 0, 1, 0]

// --- Tiles: ints 0–5 = index into ALL_TILES; tables derived from the game --

/** 4-bit red-edge mask per tile: bit d set ⇔ edge d is Red. */
export const TILE_CODE = new Uint8Array(6)
/** Red-edge mask → tile index, or -1 (valid tiles are exactly the popcount-2 codes). */
export const TILE_OF_CODE = new Int8Array(16).fill(-1)
/** [tile*4 + dir] → the other edge carrying the same color (track exit). */
export const OTHER_END = new Uint8Array(24)

for (let t = 0; t < ALL_TILES.length; t++) {
  let code = 0
  for (let d = 0; d < 4; d++) if (ALL_TILES[t][d] === 'R') code |= 1 << d
  TILE_CODE[t] = code
  TILE_OF_CODE[code] = t
  for (let d = 0; d < 4; d++) OTHER_END[t * 4 + d] = otherEnd(ALL_TILES[t], d as Dir)
}

/** Tile indices legal as the first move (indices of FIRST_TILES in ALL_TILES). */
export const FIRST_TILE_IDX: readonly number[] = FIRST_TILES.map((t) => ALL_TILES.indexOf(t))

// --- Hashing: same construction as search.ts positionHash ------------------

// Duplicated from search.ts (kept private there); tests/fastboard.test.ts
// asserts hash() === positionHash(board, turn) so the two cannot drift.
function mixCell(x: number, y: number, tileIndex: number, c1: number, c2: number): number {
  let h = (Math.imul(x, c1) ^ Math.imul(y, c2) ^ Math.imul(tileIndex + 1, 0x27d4eb2f)) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2c1b3c6d) >>> 0
  h ^= h >>> 12
  return h >>> 0
}

/** Turn salts for hash lanes, indexed by turn (0 = W, 1 = R). */
const SALT1 = [0x9e3779b9, 0x7f4a7c15]
const SALT2 = [~0x9e3779b9 >>> 0, ~0x7f4a7c15 >>> 0]

// --- Undo frames ------------------------------------------------------------

interface Frame {
  /** Placements in order, packed as cell*8 + tile (played tile first, then forced). */
  placed: number[]
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** make() results. */
export const ILLEGAL = -1
export const OK = 0
export const W_WINS = 1
export const R_WINS = 2

export class FastBoard {
  /** cell → tile index. Exposed for eval; treat as read-only outside this class. */
  readonly tiles = new Map<number, number>()
  /** 0 = White to move, 1 = Red. */
  turn: 0 | 1 = 0
  private h1 = 0
  private h2 = 0
  minX = Infinity
  maxX = -Infinity
  minY = Infinity
  maxY = -Infinity
  private readonly stack: Frame[] = []
  // Scratch buffers reused across calls (make never nests within itself).
  private readonly cascadeQueue: number[] = []
  private readonly winVisited = new Set<number>()

  static fromState(state: GameState): FastBoard {
    const fb = new FastBoard()
    for (const [k, tk] of state.board) {
      const { x, y } = parseKey(k)
      fb.insert(cellOf(x, y), ALL_TILES.indexOf(tk))
    }
    fb.turn = state.turn === 'W' ? 0 : 1
    return fb
  }

  toBoard(): Board {
    const b: Board = new Map()
    for (const [cell, t] of this.tiles) b.set(key(cellX(cell), cellY(cell)), ALL_TILES[t])
    return b
  }

  /** Number of make() calls currently un-unmade (for unwinding after a thrown timeout). */
  depth(): number {
    return this.stack.length
  }

  /**
   * 53-bit position hash keyed on tiles and side to move; identical to
   * search.ts positionHash for the same position.
   */
  hash(): number {
    const a = (this.h1 ^ SALT1[this.turn]) >>> 0
    const b = (this.h2 ^ SALT2[this.turn]) >>> 0
    return a * 0x200000 + (b >>> 11)
  }

  /**
   * Validate and apply a move, mirroring engine.ts applyMove exactly: place
   * the tile, resolve the forced-play cascade, detect wins, flip the turn.
   * Returns ILLEGAL (state unchanged), OK, W_WINS, or R_WINS.
   */
  make(cell: number, tile: number): number {
    const x = cellX(cell)
    const y = cellY(cell)
    if (x <= -COORD_LIMIT || x >= COORD_LIMIT || y <= -COORD_LIMIT || y >= COORD_LIMIT) {
      throw new Error(`FastBoard coordinate out of range: (${x}, ${y})`)
    }
    if (this.tiles.has(cell)) return ILLEGAL

    if (this.tiles.size === 0) {
      if (x !== 0 || y !== 0) return ILLEGAL
      if (!FIRST_TILE_IDX.includes(tile)) return ILLEGAL
    } else {
      let touches = false
      for (let d = 0; d < 4; d++) {
        const nt = this.tiles.get(cell + DELTA[d])
        if (nt === undefined) continue
        touches = true
        if (((TILE_CODE[nt] >>> ((d + 2) & 3)) & 1) !== ((TILE_CODE[tile] >>> d) & 1)) return ILLEGAL
      }
      if (!touches) return ILLEGAL
    }

    const frame: Frame = { placed: [], minX: this.minX, maxX: this.maxX, minY: this.minY, maxY: this.maxY }
    this.place(cell, tile, frame)

    // Forced-play cascade; see engine.ts for the order-independence argument.
    const queue = this.cascadeQueue
    queue.length = 0
    for (let d = 0; d < 4; d++) {
      const n = cell + DELTA[d]
      if (!this.tiles.has(n)) queue.push(n)
    }
    while (queue.length > 0) {
      const c = queue.pop()!
      if (this.tiles.has(c)) continue
      let w = 0
      let r = 0
      let rMask = 0
      let known = 0
      for (let d = 0; d < 4; d++) {
        const nt = this.tiles.get(c + DELTA[d])
        if (nt === undefined) continue
        known |= 1 << d
        if ((TILE_CODE[nt] >>> ((d + 2) & 3)) & 1) {
          r++
          rMask |= 1 << d
        } else {
          w++
        }
      }
      if (w > 2 || r > 2) {
        this.rollback(frame)
        return ILLEGAL
      }
      if (w < 2 && r < 2) continue
      // Fill: known edges keep their colors, missing edges take the fill
      // color (R when two white edges face in, W when two red edges do).
      const code = w >= 2 ? rMask | (0xf & ~known) : rMask
      const forced = TILE_OF_CODE[code]
      this.place(c, forced, frame)
      for (let d = 0; d < 4; d++) {
        const n = c + DELTA[d]
        if (!this.tiles.has(n)) queue.push(n)
      }
    }

    const wins = this.detectWins(frame.placed)
    const mover = this.turn
    this.turn = (this.turn ^ 1) as 0 | 1
    this.stack.push(frame)
    if (wins === 3) return mover === 0 ? W_WINS : R_WINS // mover completed both tracks
    return wins // 0 none, 1 W, 2 R
  }

  /** Undo the most recent successful make(). */
  unmake(): void {
    const f = this.stack.pop()!
    for (let i = f.placed.length - 1; i >= 0; i--) this.remove(f.placed[i])
    this.minX = f.minX
    this.maxX = f.maxX
    this.minY = f.minY
    this.maxY = f.maxY
    this.turn = (this.turn ^ 1) as 0 | 1
  }

  /**
   * Pseudo-legal moves packed as cell*8 + tile into `out`; returns the count.
   * Candidates are empty neighbors of occupied cells whose known edges all
   * match — a pre-filter only: make() stays the authoritative legality check
   * (the cascade can still reject).
   */
  moves(out: number[]): number {
    out.length = 0
    if (this.tiles.size === 0) {
      const origin = cellOf(0, 0)
      for (const t of FIRST_TILE_IDX) out.push(origin * 8 + t)
      return out.length
    }
    const seen = this.winVisited // reuse as a scratch Set; cleared below
    seen.clear()
    for (const cell of this.tiles.keys()) {
      for (let d = 0; d < 4; d++) {
        const n = cell + DELTA[d]
        if (this.tiles.has(n) || seen.has(n)) continue
        seen.add(n)
        let wMask = 0
        let rMask = 0
        for (let dd = 0; dd < 4; dd++) {
          const nt = this.tiles.get(n + DELTA[dd])
          if (nt === undefined) continue
          if ((TILE_CODE[nt] >>> ((dd + 2) & 3)) & 1) rMask |= 1 << dd
          else wMask |= 1 << dd
        }
        for (let t = 0; t < 6; t++) {
          if ((TILE_CODE[t] & wMask) === 0 && (TILE_CODE[t] & rMask) === rMask) out.push(n * 8 + t)
        }
      }
    }
    return out.length
  }

  // --- internals ------------------------------------------------------------

  /** Raw insert for fromState: no frame, no cascade, no win check. */
  private insert(cell: number, tile: number): void {
    this.tiles.set(cell, tile)
    this.hashXor(cell, tile)
    this.grow(cell)
  }

  private place(cell: number, tile: number, frame: Frame): void {
    this.tiles.set(cell, tile)
    this.hashXor(cell, tile)
    this.grow(cell)
    frame.placed.push(cell * 8 + tile)
  }

  /** Undo this frame's placements mid-make (illegal cascade); state exactly restored. */
  private rollback(frame: Frame): void {
    for (let i = frame.placed.length - 1; i >= 0; i--) this.remove(frame.placed[i])
    this.minX = frame.minX
    this.maxX = frame.maxX
    this.minY = frame.minY
    this.maxY = frame.maxY
  }

  private remove(packed: number): void {
    const cell = Math.floor(packed / 8)
    this.tiles.delete(cell)
    this.hashXor(cell, packed & 7)
  }

  /** XOR is self-inverse: the same call both places and removes a tile's hash. */
  private hashXor(cell: number, tile: number): void {
    const x = cellX(cell)
    const y = cellY(cell)
    this.h1 = (this.h1 ^ mixCell(x, y, tile, 0x85ebca6b, 0xc2b2ae35)) >>> 0
    this.h2 = (this.h2 ^ mixCell(x, y, tile, 0x9e3779b1, 0x165667b1)) >>> 0
  }

  private grow(cell: number): void {
    const x = cellX(cell)
    const y = cellY(cell)
    if (x < this.minX) this.minX = x
    if (x > this.maxX) this.maxX = x
    if (y < this.minY) this.minY = y
    if (y > this.maxY) this.maxY = y
  }

  /**
   * Int port of wins.ts detectWins over this move's placements (played +
   * forced). Returns a bitmask: bit 0 = White won, bit 1 = Red won.
   */
  private detectWins(placed: number[]): number {
    const visited = this.winVisited
    visited.clear()
    const width = this.maxX - this.minX + 1
    const height = this.maxY - this.minY + 1
    let mask = 0
    for (const p of placed) {
      const cell = Math.floor(p / 8)
      for (let color = 0; color < 2; color++) {
        if (visited.has(cell * 2 + color)) continue
        const code = TILE_CODE[this.tiles.get(cell)!]
        let d1 = -1
        let d2 = -1
        for (let d = 0; d < 4; d++) {
          if (((code >>> d) & 1) === color) {
            if (d1 < 0) d1 = d
            else d2 = d
          }
        }
        visited.add(cell * 2 + color)
        const endA = this.walk(cell, d1, color, visited)
        if (endA === -1) {
          mask |= 1 << color // loop
          continue
        }
        const endB = this.walk(cell, d2, color, visited) // a simple path cannot loop one-sided
        const aCell = Math.floor(endA / 4)
        const aDir = endA & 3
        const bCell = Math.floor(endB / 4)
        const bDir = endB & 3
        const horizontal =
          (aDir === 3 && cellX(aCell) === this.minX && bDir === 1 && cellX(bCell) === this.maxX) ||
          (bDir === 3 && cellX(bCell) === this.minX && aDir === 1 && cellX(aCell) === this.maxX)
        const vertical =
          (aDir === 0 && cellY(aCell) === this.minY && bDir === 2 && cellY(bCell) === this.maxY) ||
          (bDir === 0 && cellY(bCell) === this.minY && aDir === 2 && cellY(aCell) === this.maxY)
        if ((horizontal && width >= LINE_SPAN) || (vertical && height >= LINE_SPAN)) mask |= 1 << color
      }
    }
    return mask
  }

  /**
   * Walk `color`'s track from `startCell` leaving in direction `d`, marking
   * visited cells. Returns -1 for a loop, else the open end packed as
   * cell*4 + exitDir.
   */
  private walk(startCell: number, d: number, color: number, visited: Set<number>): number {
    let cur = startCell
    for (;;) {
      const n = cur + DELTA[d]
      const nt = this.tiles.get(n)
      if (nt === undefined) return cur * 4 + d
      // Re-entering the start tile closes the loop (see wins.ts trace).
      if (n === startCell) return -1
      visited.add(n * 2 + color)
      d = OTHER_END[nt * 4 + ((d + 2) & 3)]
      cur = n
    }
  }
}
