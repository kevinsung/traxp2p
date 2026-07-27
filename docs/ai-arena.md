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
  and a 95% confidence interval on that score. Underneath, `playGames` runs any contiguous
  range of game indices into a mergeable `MatchTally`, which is what makes `--jobs` possible.

## Running the CLI

```bash
npm run arena -- <agentA> <agentB> [--games N] [--ply N] [--seed N] [--budget MS]
                                   [--nodes N] [--jobs N|auto]
```

- `--games` (default 50) — number of games to play.
- `--ply` (default 300) — a game that runs this long without a result is scored a draw.
- `--seed` (default 1) — seeds the whole match; same seed + same agents ⇒ identical report.
- `--budget` — overrides `budgetMs` for search agents, so you can compare at equal think time.
- `--nodes` — caps `maxNodes` per move, so strength is compared at equal *work* instead of
  equal wall-clock. This is what you want whenever the machine is busy — including any run
  with `--jobs > 1`.
- `--jobs` (default 1) — play the match across N processes; `auto` uses one fewer than the
  machine's cores. See below.

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

## Running matches in parallel

Games are independent, so `--jobs N` splits `[0, games)` into N contiguous ranges of game
indices and hands each range to a child `tsx` process running `scripts/arena.ts` in shard
mode. Each child plays its range single-threaded and prints a tally (counts only, no
per-game data); the parent merges the tallies and computes one report from the totals, so
the numbers are exactly what a sequential run of the same games would produce. Progress goes
to stderr, leaving stdout as the plain report. If any child exits non-zero or fails to
report a full tally, the whole run fails with that child's stderr — you never get a quietly
short match.

Children are processes rather than threads because the search modules keep module-level
mutable state (a 24 MB transposition table, eval caches, scratch buffers explicitly written
for a single-threaded search). Separate processes isolate that for free.

Pick a job count from cores, not from games: `--jobs auto` (cores − 1) is the usual choice;
values above `--games` are clamped. On a 16-core box a 200-game match drops from ~20 minutes
to a couple of minutes. Two things to keep in mind:

1. **`--budget` is wall-clock, so it does not survive parallelism.** With J games running at
   once, each process may search far less per move than it would alone — and how much less
   depends on the machine's load. Time-budgeted results are therefore *not* comparable across
   job counts or across machines. Use `--nodes` for load-independent, apples-to-apples
   strength comparisons; keep `--budget` for answering "how strong is it at 1.5 s of real
   think time", and run that one at `--jobs 1`.
2. **The transposition table is per process.** The seed and color assignment of each game
   index are identical at any `--jobs`, but *which* games share a TT changes, so individual
   games can end differently at `--jobs 1` and `--jobs 8` for search agents. Aggregate scores
   are unaffected in expectation; a bit-identical rerun needs the same `--jobs`. (Agents with
   no state — `random` — are bit-identical at any job count.)

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
   `npm run arena -- v2 current --games 200 --seed 1 --nodes 20000 --jobs auto`.
   Colors swap automatically each game, so the result isn't an artifact of who moved first.
   `--nodes` keeps the comparison fair while all cores are busy, and `--jobs auto` is what
   makes 200 games cheap enough to actually run — don't settle for 40 games here.
5. **Control for think time.** The head-to-head above compares quality at equal *work*. To
   also check speed, re-run at equal wall-clock — `--budget 1500`, `--jobs 1` — since a
   time budget means nothing when processes are competing for cores. If v2 only wins on the
   budgeted run, that's a speed result, not a strength one.
6. **Confirm robustness.** Re-run with 1–2 other `--seed` values and a larger `--games` to
   make sure the edge holds and isn't seed noise. Only promote once it does.

### How many games you actually need

Eval tweaks here move the score by ~2–5%, and the 95% CI at 300 games is ±5.6% — wider than
the signal. A 300-game match will therefore report "significant at 95%" on pure noise, in
both directions. Measured while gating the `loopDouble` term: the *same* config scored 56.3%
at 300 games and 49.7% at 600 games on one seed, while two other seeds gave ~54% at 1000.

So: **screen at 300 games** to rank configurations and throw out clear losers, then **gate at
≥1000 games on ≥2 seeds**, and pool the raw counts across seeds before deciding. Since
`--jobs auto` a 1000-game node-capped match is minutes, so there is no reason to gate on less.

### Hold `--jobs` fixed across a comparison

Each shard is a process with its own transposition table, so `--jobs` decides how many games
share one: at 1000 games, `--jobs 30` gives ~33 games per table and `--jobs 60` gives ~17.
More sharing is more knowledge carried between games, i.e. a stronger agent. In a symmetric
self-play match this cancels, which is why the arena never shows it — but against a **fixed
external opponent it does not**. Measured 2026-07-26 against `trax-analyst`: the same build,
same seed, 1000 games scored **76.4% at `--jobs 60` and 79.7% at `--jobs 30`**.

Fix `--jobs` for every run in a comparison and record it beside the score. This rules out
`--jobs auto` for such benchmarks, since its value depends on the machine. If a delta looks
surprising, re-run the *old* build under the new settings first — if it does not reproduce,
the comparison is confounded, not the build.

## Promoting a new AI to replace the current one

The app reaches the AI in exactly one place: `src/ai/worker.ts` imports `chooseMove` from
`src/ai/search2.ts` and calls it with `AI_LIMITS`. That single import is the swap point — the
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

## Promotion log

- **2026-07-12 — v2 (FastBoard search)** replaced v1: 82% at 300 ms, 93% at 1 s.
- **2026-07-25 — `WEIGHTS.loopDouble`** added to `src/ai/eval.ts` (and its twin in
  `search2.ts`). Motivation: against `@slugbugblue/trax-analyst` essentially every loss was
  the analyst completing a *loop*, and we lost twice as often moving second. `linePotential`
  already had a "can't block both" cliff (`lineDouble`); loop threats had none, so two
  simultaneous loop threats merely added to 200. The term scores a side holding ≥2 threats
  that each complete in one move — counting loop and line threats together, so loop+line
  forks fire too.

  Gated as a separate module against the pre-term build: **53.1%** over 4000 games at
  `--nodes 20000` (3 seeds, CI 51.5–54.6) and **54.1%** over 1300 games at `--budget 1500`
  (2 seeds, CI 51.4–56.8). At `--nodes 100000` it was 51.9% over 2400 games (CI 49.9–53.9) —
  positive but *not* significant; recorded here as the one leg that did not clear. Against
  the analyst directly, 59.0% → 63.0%, with losses-as-second-player falling 57 → 47 of 200.

  Two things that did **not** work and should not be retried blind: counting threats whose
  ends are two steps apart rather than one (43–48%, clearly worse — detection precision is
  the lever, not magnitude), and raising the weight beyond `lineDouble`'s 10 000 (no
  consistent gain from 50 000 or 500 000).

- **2026-07-26 — verified one-move closability** (`closesInOne` in `src/ai/eval.ts` and its
  twin in `search2.ts`), plus `AI_LIMITS.topMargin` 5 → 1.

  The previous entry was right that detection *precision* is the lever, and this measures how
  far off it was. Scored against ground truth over 6628 positions from games lost to
  `trax-analyst`, the geometric "ends one step apart" test has 91% recall but **22%
  precision**; the two-threat cliff it feeds fires on 5.7% of positions and is wrong 64% of
  the time. Separately, the static eval called a position decisive in only **32%** of the
  positions where the side to move could win outright — and 94% of those losses ended in
  exactly such a position.

  So the geometry is kept as a *candidate generator* and the question is settled by playing
  the move: for a flagged track belonging to the side to move, try the tiles on its two exit
  cells and their neighbours (79% of real winning moves land on an exit cell, 21% adjacent),
  and if one truly closes the track, the position is won. As a win-in-1 detector that is 100%
  precise at 85% recall, and it buys a search leaf one ply on the only motif that matters.

  Against `trax-analyst` (which is a *1-ply* engine that also picks at random within 5 points
  of best — benchmark it as `suggest().pick` with `Math.random` seeded, not as `.all[0]`):
  **78.9% → 82.3%** over 4000 games × 4 seeds at `--nodes 20000` (+3.4, CI 1.7–5.2) and
  **83.0% → 86.6%** over 2100 games × 7 seeds at `--budget 1500` (+3.6, CI 1.5–5.8). Split:
  the eval term is +2.0 (CI 0.3–3.8), `topMargin` is +1.4 (CI −0.3–3.1, not significant alone
  but never negative across seeds; 1 still breaks genuine ties, so move variety survives).
  It is **level in self-play** (51.8% over 2000 games) — a symmetric tactical gain largely
  cancels there, so do not expect the arena to show it. Costs ~2x per eval and still wins on
  wall clock.

  Rejected on the way: penalising a threat the *opponent* holds (−10pt in self-play at 200),
  and replacing the imprecise 2-threat cliff with the verified one instead of adding to it
  (−10pt — converging ends have positional value even when they do not close this move).

  Residual losses are now dominated by a *single* unstoppable threat (117 of 180), not double
  threats, so one more ply of vision will not touch them.
