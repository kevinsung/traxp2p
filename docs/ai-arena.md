# AI arena: testing and swapping the computer opponent

The arena is a headless self-play harness for comparing AI implementations. It plays two
named **agents** against each other over many seeded games and reports who wins, by how
much, and whether the result is statistically meaningful — so you can tell "clearly
stronger" from "just got lucky."

## Concepts

- **`Agent`** (`src/ai/agent.ts`) — anything that can pick a move: `{ name, move(state, rand) }`.
  `searchAgent(name, chooseFn, limits)` wraps a `chooseMove`-shaped search function (like
  `src/ai/search.ts`'s `chooseMove`); `randomAgent()` is a baseline that plays uniformly at
  random. Both are deterministic given the same `rand` source, so whole matches are
  reproducible.
- **Registry** (`scripts/arena.ts`) — a `Record<string, Agent>` mapping names to agents. This
  is the one place you add a new AI to make it available to the CLI.
- **`playGame` / `playMatch`** (`src/ai/arena.ts`) — the reusable match runner. `playMatch`
  plays `games` games, swapping who plays White every other game so first-move advantage
  cancels out, and returns a `MatchReport` with win/loss/draw counts, a score for agent A,
  and a 95% confidence interval on that score.

## Running the CLI

```bash
npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N] [--budget MS]
```

- `--games` (default 50) — number of games to play.
- `--ply` (default 300) — a game that runs this long without a result is scored a draw.
- `--seed` (default 1) — seeds the whole match; same seed + same agents ⇒ identical report.
- `--budget` — overrides `budgetMs` for search agents, so you can compare at equal think time.

Example output:

```
current vs random — 50 games (seed 1, ply cap 300, budget 1500ms)

  current: 49    random: 0    draws: 1
  score for current: 99.0%  (95% CI 96.4%–100.0%)
  significant at 95% confidence
  avg game length: 14.3 plies, 62.1s total
```

Read the **score** and **confidence interval** together: an agent is meaningfully stronger
only when its score is clearly above 50% *and* the interval excludes 50%. If the CI still
straddles 50%, run more games rather than trusting the point estimate.

## Adding and testing a new AI

1. **Create the variant.** Copy the piece you want to change into a new module — e.g.
   `cp src/ai/search.ts src/ai/search-v2.ts` (and/or a new `src/ai/eval-v2.ts`), then edit
   it. Keep the same `chooseMove(state, limits)` signature so it drops straight into
   `searchAgent`.
2. **Register it** in `scripts/arena.ts`:
   ```ts
   import { chooseMove as chooseMoveV2 } from '../src/ai/search-v2'
   // inside buildRegistry(...):
   v2: searchAgent('v2', chooseMoveV2, limits),
   ```
3. **Sanity-check vs random** (fast): `npm run arena -- v2 random --games 40`. A serious AI
   should crush random, the way `current` does.
4. **Head-to-head vs current** (the real test):
   `npm run arena -- v2 current --games 200 --seed 1`.
   Colors swap automatically each game, so the result isn't an artifact of who moved first.
5. **Control for think time.** Compare at equal budgets: `--budget 1500` on both sides. If v2
   only wins because it searches longer, that's a speed result, not a strength one — re-run
   at matched budgets (and optionally matched node caps, if your variant exposes them) to
   isolate quality from compute.
6. **Confirm robustness.** Re-run with 1–2 other `--seed` values and a larger `--games` to
   make sure the edge holds and isn't seed noise. Only promote once it does.

## Promoting a new AI to replace the current one

The app reaches the AI in exactly one place: `src/ai/worker.ts` imports `chooseMove` from
`src/ai/search.ts` and calls it with `AI_LIMITS`. That single import is the swap point — the
UI, hooks (`src/hooks/useAIGame.ts`), and worker protocol (`src/ai/protocol.ts`) are all
agnostic to which search runs underneath. To make `v2` the app's opponent:

1. **Point the worker at the new implementation** — change `src/ai/worker.ts`'s import to
   `import { AI_LIMITS, chooseMove } from './search-v2'` (or alias the export if you renamed
   it). Nothing else in the hooks or protocol needs to change.
2. **Keep a regression baseline.** Leave `current` in the arena registry pointing at the old
   module (or rename it, e.g. `v1`), so you can re-run the head-to-head at any time to guard
   against future regressions.
3. **Verify end-to-end**: `npm run build` (type-check + production build), `npm test`, and
   the `verify` skill (headless browser) to confirm a full AI game still plays correctly in
   the app.
4. **Once it's permanent**, optionally collapse the variant: fold `search-v2.ts`'s contents
   into `search.ts`, delete the `-v2` file, and revert `worker.ts`'s import to `./search` so
   the app's stable entry point stays `search.ts`. Update the arena registry to match.

Follow this same recipe for every future swap, so `current` in the registry always tracks
whatever the app actually ships.
