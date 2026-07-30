#!/usr/bin/env -S npx tsx
/**
 * Self-play corpus for pricing evaluation terms.
 *
 * Plays the shipped search (`src/ai/search2.ts`) against itself and records, for
 * every position an engine moved from, the feature vector (`src/ai/features.ts`),
 * the live hand-eval score, and the game's eventual result from White's view.
 * `scripts/train-eval.ts` fits weights to those outcomes, which is what puts a
 * price in eval points on a candidate term *before* a multi-hour paired gate.
 *
 * Usage (parent — one child process per shard):
 *   npx tsx scripts/gen-selfplay.ts [--games N] [--workers N] [--seed N]
 *                                   [--nodes N] [--margin N] [--out DIR]
 *
 * Defaults: 8000 games, workers = cores − 4, seed 1, 5000 nodes/move, margin 5,
 * out `data/selfplay-v2`. Output is JSONL shards of `{ r, f, hand }`.
 *
 * Four choices worth knowing about:
 *
 * - **Self-play, not analyst games.** Against `trax-analyst` we score 96.4%, so
 *   the labels would be ~96/4 imbalanced and carry almost no gradient.
 * - **`--margin 5`, not the shipped 1.** `AI_LIMITS.topMargin` is 1 because that
 *   plays best (docs/ai-arena.md, 2026-07-26); diversity is what a *corpus* is
 *   for, and 5 is what the root pool was before that change.
 * - **`hand` is recorded, not reconstructed.** The baseline loss, the quiet mask
 *   and the rescale denominator in the trainer all come from the eval that
 *   actually shipped, so none of them can drift the way the `ml` branch's
 *   transcribed weight vector did.
 * - **Positions where the mover has a verified win in one are skipped.** They are
 *   tactically settled, and excluding them is what makes the feature basis nest
 *   the hand eval exactly (see src/ai/features.ts).
 *
 * Shards are processes, not threads: the search holds a module-level
 * transposition table, eval cache and scratch buffers. Per-game seeds come from
 * the **global** game index via `gameSeeds`, so the data is identical however
 * many workers ran it.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { gameSeeds, mulberry32 } from '../src/ai/arena'
import { extractVerified, FEATURE_COUNT } from '../src/ai/features'
import { FastBoard } from '../src/ai/fastboard'
import { chooseMove, evalWhite } from '../src/ai/search2'
import { applyMove, newGame } from '../src/game/engine'
import { legalMoves } from '../src/game/moves'
import type { GameState } from '../src/game/types'

const PLY_LIMIT = 300

interface Opts {
  games: number
  workers: number
  seed: number
  nodes: number
  margin: number
  out: string
  /** Child mode: global index of this shard's first game, or -1 for the parent. */
  shardStart: number
  shardGames: number
  shardFile: string
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = {
    games: 8000,
    workers: Math.max(1, availableParallelism() - 4),
    seed: 1,
    nodes: 5000,
    margin: 5,
    out: 'data/selfplay-v2',
    shardStart: -1,
    shardGames: 0,
    shardFile: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const v = (): string => {
      const val = argv[++i]
      if (val === undefined) throw new Error(`missing value for ${argv[i - 1]}`)
      return val
    }
    switch (argv[i]) {
      case '--games': o.games = Number(v()); break
      case '--workers': o.workers = Number(v()); break
      case '--seed': o.seed = Number(v()); break
      case '--nodes': o.nodes = Number(v()); break
      case '--margin': o.margin = Number(v()); break
      case '--out': o.out = v(); break
      case '--shard-start': o.shardStart = Number(v()); break
      case '--shard-games': o.shardGames = Number(v()); break
      case '--shard-file': o.shardFile = v(); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  return o
}

interface GameStats {
  recorded: number
  /** Positions dropped because the mover had a verified win in one. */
  settled: number
}

const buf = new Float64Array(FEATURE_COUNT)

/** Play one game; push its JSONL lines onto `lines`. */
function playGame(gameSeed: number, o: Opts, lines: string[], stats: GameStats): void {
  const rand = mulberry32(gameSeed)
  let state: GameState = newGame()

  // A short random opening (4-8 plies) for position diversity across games.
  const openingPlies = 4 + Math.floor(rand() * 5)
  for (let i = 0; i < openingPlies && !state.result; i++) {
    const moves = legalMoves(state)
    const out = applyMove(state, moves[Math.floor(rand() * moves.length)])
    if (!out.ok) throw new Error(`random opening produced an illegal move: ${out.reason}`)
    state = out.state
  }

  // Feature vectors are held until the game ends: the label is its result.
  const rows: Array<{ f: number[]; hand: number }> = []
  const limits = { budgetMs: 600_000, maxDepth: 16, maxNodes: o.nodes, topMargin: o.margin, rand }
  for (let ply = openingPlies; ply < PLY_LIMIT && !state.result; ply++) {
    const fb = FastBoard.fromState(state)
    const hand = evalWhite(fb)
    const info = extractVerified(fb, buf)
    if (info.moverWins) {
      stats.settled++
    } else {
      // Rounded to keep the shards small: every slot but `loop_far` is a count,
      // and 4 places is far finer than any weight the fit resolves.
      rows.push({
        f: Array.from(buf, (x) => Math.round(x * 10000) / 10000),
        hand: Math.round(hand * 100) / 100,
      })
    }
    const r = chooseMove(state, limits)
    if (!r) throw new Error('search returned no move for a non-terminal state')
    const out = applyMove(state, r.move)
    if (!out.ok) throw new Error(`search produced an illegal move: ${out.reason}`)
    state = out.state
  }

  const result = state.result ? (state.result.winner === 'W' ? 1 : 0) : 0.5
  for (const row of rows) lines.push(JSON.stringify({ r: result, f: row.f, hand: row.hand }))
  stats.recorded += rows.length
}

/** Child: play games [shardStart, shardStart + shardGames), append to shardFile. */
function runShard(o: Opts): void {
  writeFileSync(o.shardFile, '')
  const seeds = gameSeeds(o.seed, o.games)
  const stats: GameStats = { recorded: 0, settled: 0 }
  const lines: string[] = []
  for (let g = 0; g < o.shardGames; g++) {
    playGame(seeds[o.shardStart + g], o, lines, stats)
    if (lines.length > 5000 || g === o.shardGames - 1) {
      appendFileSync(o.shardFile, `${lines.join('\n')}\n`)
      lines.length = 0
    }
    if ((g + 1) % 5 === 0 || g === o.shardGames - 1) {
      process.send?.({ done: g + 1, recorded: stats.recorded, settled: stats.settled })
    }
  }
  // A sidecar rather than a final IPC message: the parent's `exit` handler can
  // and does fire before the last `message` is delivered, so the totals have to
  // survive in the filesystem to be exact.
  writeFileSync(o.shardFile.replace(/\.jsonl$/, '.meta.json'), `${JSON.stringify({ games: o.shardGames, ...stats })}\n`)
}

/** Parent: split the games across workers, spawn children, report progress. */
async function runParent(o: Opts): Promise<void> {
  mkdirSync(o.out, { recursive: true })
  const workers = Math.min(o.workers, o.games)
  const per = Math.ceil(o.games / workers)
  console.log(
    `generating ${o.games} games across ${workers} workers ` +
      `(${o.nodes} nodes/move, margin ${o.margin}, seed ${o.seed}) → ${o.out}/`,
  )

  const t0 = performance.now()
  const done = new Array<number>(workers).fill(0)
  const recorded = new Array<number>(workers).fill(0)
  const settled = new Array<number>(workers).fill(0)
  let lastPrint = 0
  const children: Promise<void>[] = []
  for (let w = 0, start = 0; w < workers && start < o.games; w++, start += per) {
    const games = Math.min(per, o.games - start)
    const shardFile = path.join(o.out, `shard-${String(w).padStart(3, '0')}.jsonl`)
    const args = [
      'scripts/gen-selfplay.ts',
      '--games', String(o.games),
      '--seed', String(o.seed),
      '--nodes', String(o.nodes),
      '--margin', String(o.margin),
      '--shard-start', String(start),
      '--shard-games', String(games),
      '--shard-file', shardFile,
    ]
    const idx = w
    children.push(
      new Promise<void>((resolve, reject) => {
        const child = spawn('npx', ['tsx', ...args], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
        child.on('message', (m: { done: number; recorded: number; settled: number }) => {
          done[idx] = m.done
          recorded[idx] = m.recorded
          settled[idx] = m.settled
          const total = done.reduce((s, x) => s + x, 0)
          if (total - lastPrint < 100 && total < o.games) return
          lastPrint = total
          const dt = (performance.now() - t0) / 1000
          const rows = recorded.reduce((s, x) => s + x, 0)
          const skip = settled.reduce((s, x) => s + x, 0)
          console.log(
            `  ${total}/${o.games} games, ${rows} positions ` +
              `(${skip} settled, skipped) — ${dt.toFixed(0)}s, ${(total / dt).toFixed(1)} games/s`,
          )
        })
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${idx} exited with ${code}`))))
      }),
    )
  }
  await Promise.all(children)
  let rows = 0
  let skip = 0
  for (const file of readdirSync(o.out)) {
    if (!file.endsWith('.meta.json')) continue
    const meta = JSON.parse(readFileSync(path.join(o.out, file), 'utf8')) as GameStats
    rows += meta.recorded
    skip += meta.settled
  }
  console.log(`done in ${((performance.now() - t0) / 1000).toFixed(0)}s: ${rows} positions, ${skip} settled and skipped`)
}

const opts = parseOpts(process.argv.slice(2))
if (opts.shardStart >= 0) runShard(opts)
else await runParent(opts)
