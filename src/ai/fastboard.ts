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

// --- Coordinates: 10-bit x/y fields packed into one non-negative int -------

/**
 * 10 bits per axis, so a cell index fits in 2²⁰ and can therefore *address a
 * flat array* — which is the entire reason for the narrow field: it is what
 * lets the track walks below replace their per-call `Set<number>` with a stamp
 * array, and the board itself be a flat grid rather than a Map. The range costs
 * nothing in practice: the arena's ply cap is 300, so no coordinate can reach
 * ±300 even in a pathological game, and make() throws rather than silently
 * wrapping.
 */
export const SHIFT = 10
const MASK = 0x3ff
const CENTER = 512
/**
 * make() throws beyond this rather than silently wrapping the 10-bit field.
 *
 * 510 rather than 511 because of the grid: `moves()` reads the edge masks of a
 * candidate cell, which is *two* steps from an occupied one, and on a flat array
 * a read at y = 1024 does not come back empty the way a missing Map key did — it
 * silently aliases (x+1, y = 0). Capping occupied coordinates at ±509 keeps every
 * index any loop here can form inside [1, 1023] on both axes, so the wrap is
 * unreachable rather than merely unlikely.
 */
const COORD_LIMIT = 510

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
/**
 * The two lookups a *neighbour* needs, indexed by **grid value** rather than by
 * tile index.
 *
 * `FastBoard.grid` stores a tile as `index + 1` and reserves 0 for "empty", so
 * that a fresh zero-filled `Int8Array` is already an empty board and every
 * emptiness test is `=== 0`. Consumers read a neighbour off the grid and then
 * want its tables at that value; shifting the index back at each use would put a
 * subtract on the hottest loops in the search for no reason. Slot 0 is unused.
 * `TILE_CODE` stays tile-indexed for the callers that hold a raw tile index —
 * the tile being placed, and the six candidates in `moves`.
 */
export const CELL_CODE = new Uint8Array(7)
/** [gridValue*4 + dir] → the other edge carrying the same color (track exit). */
export const CELL_OTHER_END = new Uint8Array(28)

for (let t = 0; t < ALL_TILES.length; t++) {
  let code = 0
  for (let d = 0; d < 4; d++) if (ALL_TILES[t][d] === 'R') code |= 1 << d
  TILE_CODE[t] = code
  CELL_CODE[t + 1] = code
  TILE_OF_CODE[code] = t
  for (let d = 0; d < 4; d++) CELL_OTHER_END[(t + 1) * 4 + d] = otherEnd(ALL_TILES[t], d as Dir)
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

// --- Visited stamps ---------------------------------------------------------

/** Cell indices are 10 bits per axis, so this is the whole cell space. */
export const CELL_SPACE = 1 << 20

/**
 * Generation-stamped replacements for the `Set<number>` the track walks used to
 * allocate and clear on every call. `has` becomes an array read compared
 * against the current generation, `add` a write, and `clear` an increment — no
 * allocation, no hashing. Between them `detectWins`, `walk` and `moves` run on
 * every single make(), so this is most of what a make/unmake pair was spending.
 *
 * Each consumer gets its **own lane**. `moves()` used to alias `detectWins`'
 * set, which was safe only because every caller happened to drain the move list
 * before the first make(); with a shared generation counter, a nested make()
 * would bump the generation out from under an in-progress `moves()` and it
 * would start re-emitting cells it had already seen.
 *
 * Every index these lanes see is in range: COORD_LIMIT keeps occupied cells at
 * ±509, and nothing here looks further than the two-step fringe around one.
 */
const winStamp = new Uint16Array(CELL_SPACE * 2) // cell*2 + color
let winGen = 0
const moveStamp = new Uint16Array(CELL_SPACE) // cell
let moveGen = 0

/**
 * Advance a lane's generation, wiping on the wrap.
 *
 * The lanes are 16-bit rather than 32-bit purely for residency: three of them
 * over the 2²⁰ cell space is 20 MB at 32 bits and 10 MB at 16, always resident
 * in the browser worker alongside the TT's 24 MB. The width is load-bearing
 * here, though — the modulus below **must** match the array's, or a stored stamp
 * truncates while the compared generation keeps counting, and a stale stamp from
 * generation `g` starts aliasing live generation `g + 65536`: silently missed
 * wins, not merely redundant work. A wipe every 65 535 generations costs ~0.3 ms
 * and lands roughly once per few seconds of search.
 */
export function nextGen(stamp: Uint16Array, gen: number): number {
  const next = (gen + 1) & 0xffff
  if (next !== 0) return next
  stamp.fill(0)
  return 1
}

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
  /**
   * cell → tile index + 1, 0 = empty. Exposed for eval; read-only outside.
   *
   * A flat `Int8Array` over the whole 2²⁰ cell space rather than the
   * `Map<number, number>` this used to be — the last hash on the hot path. 1 MB
   * per board sounds worse than it is: only the few pages around the origin are
   * ever touched, and one instance exists per `chooseMove`.
   */
  readonly grid = new Int8Array(CELL_SPACE)
  /**
   * The occupied cells, in placement order; only `[0, occCount)` are live.
   *
   * The grid alone cannot be iterated (2²⁰ cells for a ~40-tile board), so this
   * is the iteration order for `moves`, `toBoard` and `evalWhite`. A plain stack
   * works because placements always append and removals always come in exact
   * reverse — `unmake` and `rollback` already walk their frames backwards, which
   * is the same invariant the Map's insertion order was silently relying on. It
   * is what keeps move generation order identical to the Map version's, and
   * hence the search's behaviour unchanged.
   *
   * Reassigned on growth, so re-read it rather than caching it across a make().
   */
  occ = new Int32Array(1024)
  occCount = 0
  /** 0 = White to move, 1 = Red. */
  turn: 0 | 1 = 0
  private h1 = 0
  private h2 = 0
  minX = Infinity
  maxX = -Infinity
  minY = Infinity
  maxY = -Infinity
  private readonly stack: Frame[] = []
  // Scratch buffer reused across calls (make never nests within itself).
  private readonly cascadeQueue: number[] = []

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
    for (let i = 0; i < this.occCount; i++) {
      const cell = this.occ[i]
      b.set(key(cellX(cell), cellY(cell)), ALL_TILES[this.grid[cell] - 1])
    }
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
    if (this.grid[cell] !== 0) return ILLEGAL

    if (this.occCount === 0) {
      if (x !== 0 || y !== 0) return ILLEGAL
      if (!FIRST_TILE_IDX.includes(tile)) return ILLEGAL
    } else {
      let touches = false
      for (let d = 0; d < 4; d++) {
        const nv = this.grid[cell + DELTA[d]]
        if (nv === 0) continue
        touches = true
        if (((CELL_CODE[nv] >>> ((d + 2) & 3)) & 1) !== ((TILE_CODE[tile] >>> d) & 1)) return ILLEGAL
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
      if (this.grid[n] === 0) queue.push(n)
    }
    while (queue.length > 0) {
      const c = queue.pop()!
      if (this.grid[c] !== 0) continue
      let w = 0
      let r = 0
      let rMask = 0
      let known = 0
      for (let d = 0; d < 4; d++) {
        const nv = this.grid[c + DELTA[d]]
        if (nv === 0) continue
        known |= 1 << d
        if ((CELL_CODE[nv] >>> ((d + 2) & 3)) & 1) {
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
        if (this.grid[n] === 0) queue.push(n)
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
   *
   * With `constraints`, also fills a parallel array with each move's number of
   * occupied neighbours (0-4) — how *forcing* the placement is. This loop
   * already computes exactly that to build the edge masks, so handing it back
   * is free, and it is the only domain knowledge the search's move ordering
   * has: see `scoreMoves` in search2.ts.
   */
  moves(out: number[], constraints?: number[]): number {
    out.length = 0
    if (constraints) constraints.length = 0
    if (this.occCount === 0) {
      const origin = cellOf(0, 0)
      for (const t of FIRST_TILE_IDX) {
        out.push(origin * 8 + t)
        constraints?.push(0)
      }
      return out.length
    }
    // Own stamp lane, deliberately not detectWins': see the note there.
    moveGen = nextGen(moveStamp, moveGen)
    const occ = this.occ
    for (let i = 0, count = this.occCount; i < count; i++) {
      const cell = occ[i]
      for (let d = 0; d < 4; d++) {
        const n = cell + DELTA[d]
        if (this.grid[n] !== 0 || moveStamp[n] === moveGen) continue
        moveStamp[n] = moveGen
        let wMask = 0
        let rMask = 0
        let occupied = 0
        for (let dd = 0; dd < 4; dd++) {
          const nv = this.grid[n + DELTA[dd]]
          if (nv === 0) continue
          occupied++
          if ((CELL_CODE[nv] >>> ((dd + 2) & 3)) & 1) rMask |= 1 << dd
          else wMask |= 1 << dd
        }
        for (let t = 0; t < 6; t++) {
          if ((TILE_CODE[t] & wMask) === 0 && (TILE_CODE[t] & rMask) === rMask) {
            out.push(n * 8 + t)
            constraints?.push(occupied)
          }
        }
      }
    }
    return out.length
  }

  // --- internals ------------------------------------------------------------

  /** Raw insert for fromState: no frame, no cascade, no win check. */
  private insert(cell: number, tile: number): void {
    const x = cellX(cell)
    const y = cellY(cell)
    if (x <= -COORD_LIMIT || x >= COORD_LIMIT || y <= -COORD_LIMIT || y >= COORD_LIMIT) {
      throw new Error(`FastBoard coordinate out of range: (${x}, ${y})`)
    }
    this.put(cell, tile)
  }

  private place(cell: number, tile: number, frame: Frame): void {
    this.put(cell, tile)
    frame.placed.push(cell * 8 + tile)
  }

  private put(cell: number, tile: number): void {
    this.grid[cell] = tile + 1
    if (this.occCount === this.occ.length) {
      const bigger = new Int32Array(this.occ.length * 2)
      bigger.set(this.occ)
      this.occ = bigger
    }
    this.occ[this.occCount++] = cell
    this.hashXor(cell, tile)
    this.grow(cell)
  }

  /** Undo this frame's placements mid-make (illegal cascade); state exactly restored. */
  private rollback(frame: Frame): void {
    for (let i = frame.placed.length - 1; i >= 0; i--) this.remove(frame.placed[i])
    this.minX = frame.minX
    this.maxX = frame.maxX
    this.minY = frame.minY
    this.maxY = frame.maxY
  }

  /**
   * Undo one placement. The pop is unconditional: callers only ever remove in
   * exact reverse placement order, so `occ[occCount - 1]` is always `cell` (see
   * the note on `occ`).
   */
  private remove(packed: number): void {
    const cell = packed >>> 3
    this.grid[cell] = 0
    this.occCount--
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
    winGen = nextGen(winStamp, winGen)
    const width = this.maxX - this.minX + 1
    const height = this.maxY - this.minY + 1
    let mask = 0
    for (const p of placed) {
      const cell = p >>> 3
      for (let color = 0; color < 2; color++) {
        if (winStamp[cell * 2 + color] === winGen) continue
        const code = CELL_CODE[this.grid[cell]]
        let d1 = -1
        let d2 = -1
        for (let d = 0; d < 4; d++) {
          if (((code >>> d) & 1) === color) {
            if (d1 < 0) d1 = d
            else d2 = d
          }
        }
        winStamp[cell * 2 + color] = winGen
        const endA = this.walk(cell, d1, color)
        if (endA === -1) {
          mask |= 1 << color // loop
          continue
        }
        const endB = this.walk(cell, d2, color) // a simple path cannot loop one-sided
        const aCell = endA >>> 2
        const aDir = endA & 3
        const bCell = endB >>> 2
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
  private walk(startCell: number, d: number, color: number): number {
    let cur = startCell
    for (;;) {
      const n = cur + DELTA[d]
      const nv = this.grid[n]
      if (nv === 0) return cur * 4 + d
      // Re-entering the start tile closes the loop (see wins.ts trace).
      if (n === startCell) return -1
      winStamp[n * 2 + color] = winGen
      d = CELL_OTHER_END[nv * 4 + ((d + 2) & 3)]
      cur = n
    }
  }
}
