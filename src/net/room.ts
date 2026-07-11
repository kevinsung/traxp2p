import { joinRoom, selfId } from 'trystero'
import type { NetMsg } from './protocol'

const APP_ID = 'traxp2p-v1'

// No 0/O, 1/I/L to keep codes easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function makeRoomCode(len = 5): string {
  const rnd = crypto.getRandomValues(new Uint32Array(len))
  return [...rnd].map((r) => CODE_ALPHABET[r % CODE_ALPHABET.length]).join('')
}

export const normalizeCode = (c: string): string => c.trim().toUpperCase()

export interface RoomHandlers {
  onMessage(msg: NetMsg, from: string): void
  onPeerJoin(id: string): void
  onPeerLeave(id: string): void
  onJoinError(error: string): void
}

export interface TraxRoom {
  selfId: string
  send(msg: NetMsg, to?: string): void
  leave(): void
}

export function joinTraxRoom(code: string, handlers: RoomHandlers): TraxRoom {
  const room = joinRoom({ appId: APP_ID }, `trax-${normalizeCode(code)}`, {
    onJoinError: (d) => handlers.onJoinError(d.error),
  })
  const action = room.makeAction<NetMsg>('msg', {
    onMessage: (data, ctx) => handlers.onMessage(data, ctx.peerId),
  })
  room.onPeerJoin = (id) => handlers.onPeerJoin(id)
  room.onPeerLeave = (id) => handlers.onPeerLeave(id)
  return {
    selfId,
    send(msg, to) {
      void action.send(msg, to ? { target: to } : undefined)
    },
    leave() {
      void room.leave()
    },
  }
}
