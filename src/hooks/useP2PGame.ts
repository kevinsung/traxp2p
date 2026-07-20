import { useEffect, useReducer, useRef } from 'react'
import { applyMove, hashState, newGame, otherColor, resign, stateAtPly } from '../game/engine'
import type { Color, GameState, Move } from '../game/types'
import { PROTOCOL_VERSION, type NetMsg } from '../net/protocol'
import { joinTraxRoom, type TraxRoom } from '../net/room'

export type P2PStatus = 'waiting' | 'playing' | 'peer-left' | 'desync' | 'full' | 'error'
export type RematchState = 'none' | 'offered' | 'received'
export type UndoState = 'none' | 'offered' | 'received'
export type Role = 'host' | 'guest'

export interface P2PGame {
  state: GameState
  myColor: Color | null
  status: P2PStatus
  error: string | null
  rematch: RematchState
  undo: UndoState
  play(m: Move): void
  resign(): void
  offerRematch(): void
  acceptRematch(): void
  requestUndo(): void
  approveUndo(): void
  rejectUndo(): void
}

interface Session {
  room: TraxRoom
  state: GameState
  myColor: Color | null
  oppId: string | null
  status: P2PStatus
  error: string | null
  rematch: RematchState
  undo: UndoState
  pendingUndoTo: number | null
  destroy(): void
}

function createSession(code: string, role: Role, notify: () => void): Session {
  const s: Session = {
    room: null as unknown as TraxRoom,
    state: newGame(),
    myColor: null,
    oppId: null,
    status: 'waiting',
    error: null,
    rematch: 'none',
    undo: 'none',
    pendingUndoTo: null,
    destroy: () => s.room.leave(),
  }

  const started = () => s.myColor !== null

  const sendSync = (to: string) => {
    s.room.send(
      {
        t: 'sync',
        v: PROTOCOL_VERSION,
        yourColor: otherColor(s.myColor!),
        moves: s.state.history.map((r) => r.move),
      },
      to,
    )
  }

  const onPeerJoin = (id: string) => {
    if (s.oppId && s.oppId !== id) {
      s.room.send({ t: 'full' }, id)
      return
    }
    s.oppId = id
    if (started()) {
      // A peer (re)joined mid-game: bring them up to date.
      sendSync(id)
      if (s.status === 'peer-left') s.status = 'playing'
    } else if (role === 'host') {
      s.myColor = Math.random() < 0.5 ? 'W' : 'R'
      s.status = 'playing'
      s.room.send({ t: 'start', v: PROTOCOL_VERSION, yourColor: otherColor(s.myColor) }, id)
    }
    notify()
  }

  const onPeerLeave = (id: string) => {
    if (id !== s.oppId) return
    s.oppId = null
    if (s.status === 'playing') s.status = 'peer-left'
    clearUndo()
    notify()
  }

  const clearUndo = () => {
    s.undo = 'none'
    s.pendingUndoTo = null
  }

  const onMessage = (msg: NetMsg, from: string) => {
    switch (msg.t) {
      case 'full':
        s.status = 'full'
        break
      case 'hello':
        if (started()) sendSync(from)
        break
      case 'start':
        if (!started()) {
          s.oppId = from
          s.myColor = msg.yourColor
          s.status = 'playing'
        }
        break
      case 'sync': {
        if (msg.moves.length <= s.state.history.length && started()) break
        let st = newGame()
        for (const m of msg.moves) {
          const out = applyMove(st, m)
          if (!out.ok) {
            s.status = 'desync'
            s.error = 'received an invalid game history'
            notify()
            return
          }
          st = out.state
        }
        s.state = st
        s.oppId = from
        s.myColor = msg.yourColor
        if (s.status !== 'full') s.status = 'playing'
        clearUndo()
        break
      }
      case 'move': {
        if (from !== s.oppId || !started()) break
        if (msg.n < s.state.history.length) break // duplicate
        if (msg.n > s.state.history.length || s.state.turn === s.myColor) {
          // We missed something; ask the opponent to resend the history.
          s.room.send({ t: 'hello', v: PROTOCOL_VERSION }, from)
          break
        }
        const out = applyMove(s.state, { x: msg.x, y: msg.y, tile: msg.tile })
        if (!out.ok || hashState(out.state) !== msg.hash) {
          s.status = 'desync'
          s.error = out.ok ? 'positions diverged after a move' : `illegal move received: ${out.reason}`
          break
        }
        s.state = out.state
        break
      }
      case 'resign':
        if (from === s.oppId && s.myColor) s.state = resign(s.state, otherColor(s.myColor))
        break
      case 'rematch':
        if (from !== s.oppId) break
        if (msg.accept && s.rematch === 'offered') startRematch()
        else if (!msg.accept) s.rematch = 'received'
        break
      case 'undo-request':
        if (from !== s.oppId || s.undo !== 'none') break
        if (msg.to < 0 || msg.to >= s.state.history.length) break
        s.undo = 'received'
        s.pendingUndoTo = msg.to
        break
      case 'undo-response':
        if (from !== s.oppId || s.undo !== 'offered') break
        if (msg.accept && s.pendingUndoTo !== null) s.state = stateAtPly(s.state.history, s.pendingUndoTo)
        clearUndo()
        break
    }
    notify()
  }

  const startRematch = () => {
    s.state = newGame()
    s.myColor = otherColor(s.myColor!)
    s.rematch = 'none'
    clearUndo()
  }

  s.room = joinTraxRoom(code, {
    onMessage,
    onPeerJoin,
    onPeerLeave,
    onJoinError: (error) => {
      s.status = 'error'
      s.error = error
      notify()
    },
  })

  return s
}

export function useP2PGame(code: string, role: Role): P2PGame {
  const [, notify] = useReducer((x: number) => x + 1, 0)
  const ref = useRef<Session | null>(null)

  useEffect(() => {
    const session = createSession(code, role, notify)
    ref.current = session
    notify()
    return () => {
      ref.current = null
      session.destroy()
    }
  }, [code, role])

  const s = ref.current

  return {
    state: s?.state ?? newGame(),
    myColor: s?.myColor ?? null,
    status: s?.status ?? 'waiting',
    error: s?.error ?? null,
    rematch: s?.rematch ?? 'none',
    undo: s?.undo ?? 'none',
    play(m: Move) {
      if (!s || s.status !== 'playing' || !s.myColor || s.state.turn !== s.myColor || s.undo !== 'none') return
      const n = s.state.history.length
      const out = applyMove(s.state, m)
      if (!out.ok) return
      s.state = out.state
      s.room.send({ t: 'move', n, x: m.x, y: m.y, tile: m.tile, hash: hashState(out.state) })
      notify()
    },
    resign() {
      if (!s || !s.myColor || s.state.result) return
      s.state = resign(s.state, s.myColor)
      s.room.send({ t: 'resign' })
      notify()
    },
    offerRematch() {
      if (!s || s.rematch !== 'none') return
      s.rematch = 'offered'
      s.room.send({ t: 'rematch', accept: false })
      notify()
    },
    acceptRematch() {
      if (!s || s.rematch !== 'received') return
      s.room.send({ t: 'rematch', accept: true })
      s.state = newGame()
      s.myColor = otherColor(s.myColor!)
      s.rematch = 'none'
      s.undo = 'none'
      s.pendingUndoTo = null
      notify()
    },
    requestUndo() {
      if (!s || s.status !== 'playing' || !s.oppId || !s.myColor || s.undo !== 'none') return
      const to = s.state.history.length - (s.state.turn === s.myColor ? 2 : 1)
      if (to < 0) return
      s.undo = 'offered'
      s.pendingUndoTo = to
      s.room.send({ t: 'undo-request', to })
      notify()
    },
    approveUndo() {
      if (!s || s.undo !== 'received' || s.pendingUndoTo === null) return
      s.state = stateAtPly(s.state.history, s.pendingUndoTo)
      s.room.send({ t: 'undo-response', accept: true })
      s.undo = 'none'
      s.pendingUndoTo = null
      notify()
    },
    rejectUndo() {
      if (!s || s.undo !== 'received') return
      s.room.send({ t: 'undo-response', accept: false })
      s.undo = 'none'
      s.pendingUndoTo = null
      notify()
    },
  }
}
