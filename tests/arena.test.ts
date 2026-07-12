import { describe, expect, it } from 'vitest'
import { randomAgent, searchAgent } from '../src/ai/agent'
import { playMatch } from '../src/ai/arena'
import { chooseMove } from '../src/ai/search'
import type { SearchLimits } from '../src/ai/search'

/**
 * Deterministic, capped limits so matches run fast in the test suite.
 *
 * budgetMs is kept small deliberately: at maxDepth 2, ctx.nodes (search.ts)
 * only counts internal negamax calls, not the leaf evaluate() calls done at
 * the frontier — so maxNodes does not reliably cap real work, and budgetMs
 * is the true backstop for a single chooseMove call. A large budgetMs (as
 * used for slow-but-bounded production search) turns every move into a
 * potential multi-second-to-minute stall here, which self-mirror games (both
 * sides doing real search) can hit repeatedly across a whole match.
 */
const testLimits: SearchLimits = { budgetMs: 300, maxDepth: 2, maxNodes: 5_000 }

describe('arena', () => {
  it('current beats random by a wide margin', () => {
    const current = searchAgent('current', chooseMove, testLimits)
    const random = randomAgent('random')
    const report = playMatch(current, random, { games: 8, plyLimit: 100, seed: 1 })
    expect(report.aWins).toBeGreaterThan(report.bWins)
    expect(report.scoreForA).toBeGreaterThan(0.5)
  })

  it('is reproducible for a fixed seed', () => {
    const current = searchAgent('current', chooseMove, testLimits)
    const random = randomAgent('random')
    const r1 = playMatch(current, random, { games: 6, plyLimit: 100, seed: 42 })
    const r2 = playMatch(current, random, { games: 6, plyLimit: 100, seed: 42 })
    expect(r2).toEqual(r1)
  })

  it('plays a self-mirror match to completion without crashing', () => {
    // A smoke test, not a strength test: both sides pay full search cost on
    // every ply (unlike the tests above, where random moves are instant), so
    // this uses a much smaller budget/ply cap to stay cheap. Hitting the ply
    // cap and drawing is a perfectly valid outcome here.
    const smokeLimits: SearchLimits = { budgetMs: 100, maxDepth: 2, maxNodes: 1_000 }
    const a = searchAgent('current', chooseMove, smokeLimits)
    const b = searchAgent('current', chooseMove, smokeLimits)
    const report = playMatch(a, b, { games: 1, plyLimit: 20, seed: 7 })
    expect(report.aWins + report.bWins + report.draws).toBe(1)
  })

  it('rejects a zero-game match', () => {
    const current = searchAgent('current', chooseMove, testLimits)
    const random = randomAgent('random')
    expect(() => playMatch(current, random, { games: 0 })).toThrow()
  })
})
