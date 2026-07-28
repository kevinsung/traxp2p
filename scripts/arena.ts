#!/usr/bin/env -S npx tsx
/**
 * Self-play arena CLI. Pits two named agents against each other over a
 * seeded, color-swapping match and reports the result.
 *
 * Usage: npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N]
 *                         [--budget MS] [--nodes N] [--jobs N|auto]
 *
 * With --jobs > 1 the match is split into contiguous ranges of game indices
 * and each range is played by a child `tsx` process running this same script
 * in shard mode (--shard-start/--shard-count, hidden); the parent merges the
 * shards' tallies into one report. Search modules keep module-level state (a
 * transposition table, eval caches, scratch buffers), so shards must be
 * separate processes rather than threads.
 *
 * See docs/ai-arena.md for the full workflow: adding a new AI, testing it
 * against `current`, and promoting a winner.
 */
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomAgent, searchAgent, type Agent } from '../src/ai/agent'
import { mergeTallies, playGames, summarize, type MatchTally } from '../src/ai/arena'
import { AI_LIMITS, chooseMove as chooseMoveV1, type SearchLimits } from '../src/ai/search'
import { chooseMove as chooseMoveV2 } from '../src/ai/search2'
import { chooseMove as chooseMoveBase } from '../src/ai/search2base'

const SCRIPT = fileURLToPath(import.meta.url)
const TSX_BIN = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))

/**
 * Named agents available to the arena. Add a new implementation here to
 * benchmark it against `current` — e.g. after copying src/ai/search.ts to
 * src/ai/search-v2.ts and editing it:
 *
 *   import { chooseMove as chooseMoveV2 } from '../src/ai/search-v2'
 *   ...
 *   v2: searchAgent('v2', chooseMoveV2, limits),
 */
function buildRegistry(limits: SearchLimits): Record<string, Agent> {
  return {
    // `current` tracks what the app ships (src/ai/worker.ts): the FastBoard
    // search. `v1` is the previous engine-based search, kept as a regression
    // baseline (promoted 2026-07-12: v2 beat v1 82% at 300ms, 93% at 1s).
    //
    // eval's loopDouble term promoted 2026-07-25: 53.1% over 4000 games at
    // --nodes 20000 (3 seeds, CI 51.5-54.6) and 54.1% over 1300 games at
    // --budget 1500 (2 seeds, CI 51.4-56.8) against the pre-term build.
    current: searchAgent('current', chooseMoveV2, limits),
    // Frozen copy of the shipped search + board as of commit 14da60e (see
    // src/ai/search2base.ts); the regression baseline while search work is in
    // flight, and the arm `scripts/vs-analyst.ts --agents base,current` pairs against.
    base: searchAgent('base', chooseMoveBase, limits),
    v1: searchAgent('v1', chooseMoveV1, limits),
    random: randomAgent('random'),
  }
}

interface Args {
  positional: string[]
  opts: Record<string, string>
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const value = argv[++i]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      opts[arg.slice(2)] = value
    } else {
      positional.push(arg)
    }
  }
  return { positional, opts }
}

/** Drop `--name value` from an argv, so it can be replaced or omitted. */
function stripOpt(argv: string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) {
      i++ // also skip its value
      continue
    }
    out.push(argv[i])
  }
  return out
}

function usage(availableAgents?: string[]): never {
  console.error(
    'Usage: npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N] ' +
      '[--budget MS] [--nodes N] [--jobs N|auto]',
  )
  if (availableAgents) console.error(`Available agents: ${availableAgents.join(', ')}`)
  process.exit(1)
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

/** `auto` leaves a core for the parent and the rest of the machine. */
function parseJobs(value: string | undefined, games: number): number {
  const requested = value === 'auto' ? availableParallelism() - 1 : value ? Number(value) : 1
  if (!Number.isFinite(requested) || requested < 1) throw new Error(`invalid --jobs value: ${value}`)
  return Math.max(1, Math.min(Math.floor(requested), games))
}

/** Split `[0, total)` into `jobs` contiguous ranges of game indices. */
function splitRanges(total: number, jobs: number): Array<{ start: number; count: number }> {
  const base = Math.floor(total / jobs)
  const remainder = total % jobs
  const ranges: Array<{ start: number; count: number }> = []
  let start = 0
  for (let i = 0; i < jobs; i++) {
    const count = base + (i < remainder ? 1 : 0)
    if (count === 0) continue
    ranges.push({ start, count })
    start += count
  }
  return ranges
}

function isTally(value: unknown): value is MatchTally {
  const t = value as MatchTally
  return (
    typeof t === 'object' &&
    t !== null &&
    typeof t.games === 'number' &&
    typeof t.aWins === 'number' &&
    typeof t.bWins === 'number' &&
    typeof t.draws === 'number' &&
    typeof t.totalPlies === 'number'
  )
}

/**
 * Run one shard as a child `tsx` process. Rejects on a non-zero exit or an
 * unreadable tally: a shard that silently dropped its games would turn into a
 * short match reported as if it were complete.
 */
function runShardProcess(
  argv: string[],
  range: { start: number; count: number },
  onProgress: (done: number) => void,
): { child: ReturnType<typeof spawn>; tally: Promise<MatchTally> } {
  const args = [SCRIPT, ...argv, '--shard-start', String(range.start), '--shard-count', String(range.count)]
  const child = spawn(TSX_BIN, args, { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] })
  const label = `shard [${range.start}, ${range.start + range.count})`

  const tally = new Promise<MatchTally>((resolve, reject) => {
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('message', (msg) => {
      const done = (msg as { done?: unknown }).done
      if (typeof done === 'number') onProgress(done)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code !== 0) return reject(new Error(`${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      const line = out.trim().split('\n').at(-1)
      let parsed: unknown
      try {
        parsed = line ? JSON.parse(line) : undefined
      } catch {
        parsed = undefined
      }
      if (!isTally(parsed)) return reject(new Error(`${label} produced no readable tally (last line: ${line ?? ''})`))
      if (parsed.games !== range.count) {
        return reject(new Error(`${label} reported ${parsed.games} games, expected ${range.count}`))
      }
      resolve(parsed)
    })
  })
  return { child, tally }
}

/**
 * Progress on stderr — stdout stays the parseable report. Throttled to ~1/s,
 * redrawn in place on a terminal and appended line by line otherwise.
 */
function makeProgress(total: number): (done: number) => void {
  let lastAt = 0
  return (done) => {
    const now = performance.now()
    if (done < total && now - lastAt < 1000) return
    lastAt = now
    const line = `  ${done}/${total} games`
    process.stderr.write(process.stderr.isTTY ? `\r${line}${done >= total ? '\n' : ''}` : `${line}\n`)
  }
}

async function runParallel(argv: string[], games: number, jobs: number): Promise<MatchTally> {
  const report = makeProgress(games)
  const perShard = new Map<number, number>()
  const childArgv = stripOpt(argv, 'jobs')
  const shards = splitRanges(games, jobs).map((range, i) =>
    runShardProcess(childArgv, range, (done) => {
      perShard.set(i, done)
      let total = 0
      for (const n of perShard.values()) total += n
      report(total)
    }),
  )
  try {
    return mergeTallies(await Promise.all(shards.map((s) => s.tally)))
  } catch (err) {
    for (const s of shards) s.child.kill()
    throw err
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const { positional, opts } = parseArgs(argv)
  const [nameA, nameB] = positional

  const limits: SearchLimits = { ...AI_LIMITS }
  if (opts.budget) limits.budgetMs = Number(opts.budget)
  if (opts.nodes) limits.maxNodes = Number(opts.nodes)
  const registry = buildRegistry(limits)

  if (!nameA || !nameB) usage(Object.keys(registry))
  const a = registry[nameA]
  const b = registry[nameB]
  if (!a || !b) usage(Object.keys(registry))

  const games = opts.games ? Number(opts.games) : 50
  const plyLimit = opts.ply ? Number(opts.ply) : 300
  const seed = opts.seed ? Number(opts.seed) : 1
  if (!Number.isFinite(games) || games < 1) throw new Error('--games must be at least 1')

  // Shard mode: play our slice of the match, then hand the counts back to the
  // parent as the last line of stdout.
  if (opts['shard-start'] !== undefined) {
    const start = Number(opts['shard-start'])
    const count = Number(opts['shard-count'])
    if (!Number.isFinite(start) || !Number.isFinite(count)) throw new Error('bad --shard-start/--shard-count')
    let done = 0
    const tally = playGames(a, b, {
      games,
      plyLimit,
      seed,
      start,
      count,
      onGame: () => process.send?.({ done: ++done }),
    })
    console.log(JSON.stringify(tally))
    process.disconnect?.()
    return
  }

  const jobs = parseJobs(opts.jobs, games)
  const nodeCap = limits.maxNodes ? `, node cap ${limits.maxNodes}` : ''
  console.log(
    `${a.name} vs ${b.name} — ${games} games (seed ${seed}, ply cap ${plyLimit}, ` +
      `budget ${limits.budgetMs}ms${nodeCap}${jobs > 1 ? `, ${jobs} jobs` : ''})`,
  )

  const start = performance.now()
  const tally =
    jobs > 1 ? await runParallel(argv, games, jobs) : playGames(a, b, { games, plyLimit, seed, start: 0, count: games })
  const elapsedS = ((performance.now() - start) / 1000).toFixed(1)
  const report = summarize(a.name, b.name, tally)

  console.log('')
  console.log(`  ${report.a}: ${report.aWins}    ${report.b}: ${report.bWins}    draws: ${report.draws}`)
  console.log(
    `  score for ${report.a}: ${formatPct(report.scoreForA)}  ` +
      `(95% CI ${formatPct(report.confidenceInterval[0])}–${formatPct(report.confidenceInterval[1])})`,
  )
  console.log(`  ${report.significant ? 'significant at 95% confidence' : 'not significant — run more games'}`)
  console.log(`  avg game length: ${report.avgPlies.toFixed(1)} plies, ${elapsedS}s total`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
