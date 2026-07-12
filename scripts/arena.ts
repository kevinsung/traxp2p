#!/usr/bin/env -S npx tsx
/**
 * Self-play arena CLI. Pits two named agents against each other over a
 * seeded, color-swapping match and reports the result.
 *
 * Usage: npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N] [--budget MS]
 *
 * See docs/ai-arena.md for the full workflow: adding a new AI, testing it
 * against `current`, and promoting a winner.
 */
import { randomAgent, searchAgent, type Agent } from '../src/ai/agent'
import { playMatch } from '../src/ai/arena'
import { AI_LIMITS, chooseMove } from '../src/ai/search'

/**
 * Named agents available to the arena. Add a new implementation here to
 * benchmark it against `current` — e.g. after copying src/ai/search.ts to
 * src/ai/search-v2.ts and editing it:
 *
 *   import { chooseMove as chooseMoveV2 } from '../src/ai/search-v2'
 *   ...
 *   v2: searchAgent('v2', chooseMoveV2, limits),
 */
function buildRegistry(limits: typeof AI_LIMITS): Record<string, Agent> {
  return {
    current: searchAgent('current', chooseMove, limits),
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

function usage(availableAgents?: string[]): never {
  console.error('Usage: npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N] [--budget MS]')
  if (availableAgents) console.error(`Available agents: ${availableAgents.join(', ')}`)
  process.exit(1)
}

function formatPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`
}

function main(): void {
  const { positional, opts } = parseArgs(process.argv.slice(2))
  const [nameA, nameB] = positional

  const budgetMs = opts.budget ? Number(opts.budget) : undefined
  const limits = budgetMs ? { ...AI_LIMITS, budgetMs } : AI_LIMITS
  const registry = buildRegistry(limits)

  if (!nameA || !nameB) usage(Object.keys(registry))
  const a = registry[nameA]
  const b = registry[nameB]
  if (!a || !b) usage(Object.keys(registry))

  const games = opts.games ? Number(opts.games) : 50
  const plyLimit = opts.ply ? Number(opts.ply) : 300
  const seed = opts.seed ? Number(opts.seed) : 1

  console.log(`${a.name} vs ${b.name} — ${games} games (seed ${seed}, ply cap ${plyLimit}, budget ${limits.budgetMs}ms)`)
  const start = performance.now()
  const report = playMatch(a, b, { games, plyLimit, seed })
  const elapsedS = ((performance.now() - start) / 1000).toFixed(1)

  console.log('')
  console.log(`  ${report.a}: ${report.aWins}    ${report.b}: ${report.bWins}    draws: ${report.draws}`)
  console.log(
    `  score for ${report.a}: ${formatPct(report.scoreForA)}  ` +
      `(95% CI ${formatPct(report.confidenceInterval[0])}–${formatPct(report.confidenceInterval[1])})`,
  )
  console.log(`  ${report.significant ? 'significant at 95% confidence' : 'not significant — run more games'}`)
  console.log(`  avg game length: ${report.avgPlies.toFixed(1)} plies, ${elapsedS}s total`)
}

main()
