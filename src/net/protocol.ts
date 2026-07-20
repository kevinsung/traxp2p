import type { Color, TileKind } from '../game/types'

export const PROTOCOL_VERSION = 1

/**
 * P2P protocol: both peers run the same deterministic engine and exchange
 * moves only. Each move carries its sequence number and a hash of the
 * resulting position so desyncs are detected instead of silently diverging.
 */
export type NetMsg =
  /** Ask the other peer for a `start` or `sync` (sent on arrival/gap). */
  | { t: 'hello'; v: number }
  /** Host assigns the guest's color for a fresh game. */
  | { t: 'start'; v: number; yourColor: Color }
  /** Full-history resync for a (re)joining peer. */
  | {
      t: 'sync'
      v: number
      yourColor: Color
      moves: Array<{ x: number; y: number; tile: TileKind }>
    }
  | { t: 'move'; n: number; x: number; y: number; tile: TileKind; hash: string }
  | { t: 'resign' }
  | { t: 'rematch'; accept: boolean }
  /** Ask the opponent to rewind history so its length becomes `to`. */
  | { t: 'undo-request'; to: number }
  | { t: 'undo-response'; accept: boolean }
  /** The room already has two players. */
  | { t: 'full' }
