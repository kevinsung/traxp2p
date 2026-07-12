# Trax P2P

A web app for playing [Trax](https://en.wikipedia.org/wiki/Trax_(game)), the two-player
abstract strategy game of loops and lines — locally on one device, or peer-to-peer over
the Internet with no game server.

## Features

- **Standard Trax rules**: unbounded board, forced-play cascades, win by loop or by a
  line spanning 8+ rows/columns (simultaneous wins go to the mover; completing your
  opponent's track loses).
- **Local hotseat play** with undo, resign, and standard Trax move notation.
- **P2P play** over WebRTC data channels via [Trystero](https://github.com/dmotz/trystero):
  signaling runs over public Nostr relays, so the whole app is a static site — create a
  room, share the 5-character code (or invite link), and play. Disconnected opponents can
  rejoin with the same code and are resynced.
- SVG board with pan/zoom (mouse, wheel, touch pinch), a tile picker showing only legal
  placements, animated forced-tile cascades, and winning-track highlighting.

## Development

```bash
npm install
npm run dev       # local dev server
npm test          # game-engine test suite (vitest)
npm run build     # type-check + production build (static site in dist/)
npm run arena -- current random --games 50   # AI self-play arena, see docs/ai-arena.md
```

To try P2P locally, open the app in two separate browser profiles/windows (they need
distinct storage), create a room in one, and join with the code in the other.

## Architecture

- `src/game/` — pure TypeScript engine, no React: tile model (a tile is its four edge
  colors), move validation, forced-play cascade, loop/line detection, Trax notation.
- `src/net/` — message protocol and a thin Trystero room wrapper. Peers exchange only
  moves; both sides run the same deterministic engine, and every move carries a position
  hash so desyncs are detected instead of diverging.
- `src/ui/` + `src/hooks/` — React components (board, picker, game screen, lobby) and
  the local/P2P game controllers.
- `src/ai/` — the computer opponent (search + evaluation) and a headless self-play arena
  for comparing implementations; see [`docs/ai-arena.md`](docs/ai-arena.md).

Deploy by serving `dist/` from any static host (GitHub Pages, Netlify, Cloudflare Pages).

## License

[AGPL-3.0](LICENSE)
