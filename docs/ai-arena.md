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

1. **`--budget` is wall-clock, so it does not survive parallelism** — at least not across
   *different* job counts. With J games running at once each process may search less per move
   than it would alone, by an amount that depends on the machine's load, so a budgeted score
   is meaningless on its own and never comparable across job counts or machines.

   It is still comparable *within* one setting, which matters because a 1000-game budgeted
   gate at `--jobs 1` takes about five hours here and under an hour at `--jobs 8`. So: a
   budgeted comparison may run at `--jobs J` provided all three hold —

   - **J is well under the core count** (leave the box room; oversubscription is what makes
     per-move think time collapse unpredictably),
   - **the box is otherwise idle** for the whole comparison, and
   - **J is identical for both arms**, and recorded beside the score.

   Then apply the confound check below: re-run the *old* build under the new settings and
   confirm its number reproduces. If it does not, the delta is measuring the settings, not
   the build. Use `--nodes` when you want a result that needs none of this care.
2. **The transposition table is per process.** The seed and color assignment of each game
   index are identical at any `--jobs`, but *which* games share a TT changes, so individual
   games can end differently at `--jobs 1` and `--jobs 8` for search agents. Aggregate scores
   are unaffected in expectation; a bit-identical rerun needs the same `--jobs`. (Agents with
   no state — `random` — are bit-identical at any job count.)

## Benchmarking against trax-analyst

Self-play is a poor instrument for tactical and eval work: a symmetric gain largely cancels
when both sides have it. The `closesInOne` change was **level in self-play (51.8%)** and worth
**+3.4pt** against a fixed external opponent. So the real gate is `scripts/vs-analyst.ts`,
which plays us against `@slugbugblue/trax-analyst`:

```bash
npm run vs-analyst -- [--agent NAME | --agents A,B] [--games N] [--seed N | --seeds 1,2,3]
                      [--ply N] [--budget MS] [--nodes N] [--margin N] [--jobs N]
                      [--analyst pick|best] [--diag] [--out FILE]
```

It shards like the arena and shares its seeding (`gameSeeds` by global index), so a shard
plays exactly the games it would have in a sequential run. Points to know:

- **The analyst is a 1-ply engine that picks at random within 5 points of best.** Benchmark it
  as `suggest().pick`, which is what this does, with `Math.random` swapped for a seeded stream
  on its own salt. `--analyst best` (strict `.all[0]`) exists only to reproduce old numbers.
- **Every ply is bridge-checked** against `@slugbugblue/trax`'s own position. The `/` vs `\`
  notation bug (commit 9a84b19) is what this guards against: a silently divergent bridge
  invalidates every number in the run, so a mismatch aborts it.
- **`--nodes` lifts the time budget** unless `--budget` is also given. The shipped budget is
  1500 ms and this search runs on the order of 10k nodes/s, so a 20000-node cap binds only
  about half the time and the clock cuts the rest — which would hand a *faster* build more
  nodes than the baseline at nominally equal work. Pass `--nodes N --budget 1500` to reproduce
  a historical number measured before this rule existed.
- **`--jobs auto` is rejected.** Against a fixed opponent the job count changes the score by
  ~3pt (see below), so it must be pinned and recorded.
- **`--seeds 1,2` pools raw counts** across seeds into one CI, which is the pooling the "how
  many games" section asks for and is easy to get wrong by averaging percentages.
- **`--agents a,b`** plays both builds over identical game seeds, interleaved inside each
  shard, and reports the paired difference. Caveat: both arms then live in one process holding
  separate module-level transposition tables, so each *absolute* score sits below a solo run —
  the comparison stays fair because the handicap is equal for both.

Two numbers it reports that the arena cannot:

- **nps, nodes/move and a completed-depth histogram**, from the `SearchResult` every move
  already returns. This is what tells a speed win from a strength win — and search speed
  converts directly into depth, and therefore strength, at a time budget.
- **`--diag`: a loss taxonomy.** For each loss it finds the first ply where *every* one of our
  legal moves handed the analyst a win-in-1, and how many winning replies it had there
  (`forkWidth`). `forkWidth == 1` is a single unstoppable threat: a position we should never
  have entered, which more search depth can avoid. `>= 2` is a genuine fork, which one more
  ply cannot fix and which needs better threat detection. Which bucket dominates is what
  decides where the next round of work should go.

### Deciding a match early: `--sprt`

A budgeted 2000-game gate runs over an hour, and most of them are settled long before
the end. `--sprt` runs a sequential probability ratio test on the paired difference and
stops the match as soon as it crosses a bound:

```bash
npm run vs-analyst -- --agents current,pre1 --games 1000 --seeds 1,2 --budget 1500 \
                      --jobs 16 --diag --sprt [--sprt-delta 0.02]
```

- **It needs `--agents A,B`.** The test is defined on the paired per-game difference —
  the quantity the `pairHist` histogram already carries — and H1 is "A is better by
  `--sprt-delta`" (default 0.02, i.e. +2pt).
- **α = β = 0.05**, so the bounds are ±2.94 on the log-likelihood ratio. The statistic is
  the normal-approximation GSPRT for a mean shift, `n·δ·(x̄ − δ/2)/σ̂²`, using the
  *observed* variance — which is what makes it valid for a paired difference, whose
  variance is far below either arm's alone.
- **It will not fire below 50 pairs.** Early on the differences are mostly zero, the
  sample variance is 0, and the LLR is ±infinity; without the floor this decided a match
  after 9 games.
- **The result is reproducible in its decision, not in its game count.** With `--jobs > 1`
  the pairs finished when the bound is crossed are not a prefix of the match, so a rerun
  stops somewhere else. Record `--jobs` beside it, as always.
- Shards learn about the decision through a temp file they stat between games, not over
  IPC: `playRange` is one long synchronous loop, so a child's event loop never runs and an
  IPC message would not be delivered until the shard had already finished.

An `--sprt` run still prints the full report, so `--diag` and `--out` work alongside it.

## Measuring mechanism, not strength: `npm run bench`

The arena and vs-analyst answer "is this stronger". `scripts/bench.ts` answers "is this
faster, and what does a ply cost" — the two mechanism numbers that decide whether a change
deserves a 4000-game gate at all.

```bash
npm run bench -- [--agents A,B] [--fixture losses|mixed] [--budget MS | --nodes N]
npm run bench -- --depths 3,4,5,6 [--agents A,B] [--fixture losses|mixed]
npm run bench -- --from dump.json --key losses|nonLosses [--count 38] [--ply 20]
```

**There are two committed fixtures and a mechanism claim has to clear both.** Each is 38
positions at ply 20 from real games against the analyst, out of a `vs-analyst --out` dump:

| `--fixture` | file | drawn from |
|---|---|---|
| `losses` (default) | `scripts/bench-positions.json` | games we lost — tactical motifs are dense |
| `mixed` | `scripts/bench-positions-mixed.json` | sampled won and drawn games — the control |

Two of them because one was not enough. The incremental-endpoints round (2026-07-29) measured
−15.8% nodes on `losses` and converted to +0.24pt in real games: a converging-track prior is
precisely a tactical-motif detector, and the loss fixture is close to a best case for one.
Ratios there are trustworthy for changes that touch every node equally and an **upper bound**
for anything keyed on a motif. `mixed` is the honest half of that pair. Sample generously
when regenerating it — `--out-sample 6` over 3000 games gave 478 games but only 38 distinct
ply-20 positions, since the analyst's openings repeat heavily.

Committing the fixtures is the point — a number from today stays comparable with one from
months ago even after the analyst dependency moves.

Three things to know before quoting a number from either:

- **Measure nodes-to-complete-depth directly; never read a branching factor off the depth
  histogram.** `chooseMove` reports the last *fully completed* iteration and, since
  partial-iteration retention, keeps work from an aborted deeper one — so the histogram
  understates what the search looked at, and mean-depth-at-a-node-cap gives an effective
  branching factor around 27 where the truth is under 7. `--depths` lifts the clock and the
  node cap and fixes `maxDepth`, which is the only honest way to ask.
- **The transposition table persists across positions and across rows.** Depth 5 measured
  alone is not the depth 5 of a `3,4,5` run (~570k vs ~470k nodes here). That is the
  condition the shipped search runs in, so it is not a bug — but only rows within one
  invocation, and arms within one row, are comparable.
- **Absolute node counts do not survive regenerating the fixture**, only ratios do.

Measured 2026-07-29 on the `losses` fixture: depth 3 → 4 costs ×10.9 and 4 → 5 costs ×3.1,
for a geometric-mean **effective branching factor of 5.8**. The odd/even oscillation is
normal alpha-beta behaviour and the geometric mean is the number to quote. It is *below*
the √76 ≈ 8.7 that perfect ordering buys a plain minimax, which is why ordering heuristics
keep returning nothing here and why the eval, not the search, is where the remaining work is.

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
   also check speed, re-run at equal wall-clock — `--budget 1500` at a small, pinned
   `--jobs` (see the rules above) — since a time budget means nothing when processes are
   competing for cores. If v2 only wins on the budgeted run, that's a speed result, not a
   strength one.
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

   When the change is an edit to `search2.ts` in place rather than a new module, freeze a copy
   first — `src/ai/search2base.ts` and `src/ai/fastboardbase.ts` are the frozen build from
   before the 2026-07-27 search work, registered as `base` in both CLIs. That is what makes
   `--agents base,current` possible, and a **paired** run is worth a lot: both arms play the
   same game seeds against the same analyst stream under the same load, so the per-game
   results pair and the difference has far less variance than two separate runs. It is also
   the only way the numbers in a promotion-log entry stay reproducible after the fact. The
   baseline modules are dead code for the app bundle (`worker.ts` imports only `./search2`).
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

- **2026-07-27 — search efficiency**: four changes to `src/ai/search2.ts` and
  `src/ai/fastboard.ts`, no change to the evaluation. The previous entry concluded the eval
  well had run dry and the residue was a *search* problem; this is that round.

  **Result, against `trax-analyst` at the shipped `--budget 1500`: 86.0% → 92.8%, i.e.
  +6.90pt (95% CI 4.97–8.83)** over 2000 identical games × 2 seeds, `--jobs 16`, played
  paired (`--agents base,current`) so both arms saw the same seeds, the same analyst stream
  and the same machine load. Losses fell 281 → 143. At *equal work* (`--nodes 20000`,
  2000 games × 2 seeds, `--jobs 30`) it is 91.0% → 93.6%, **+2.65pt (CI 1.01–4.29)**. So
  roughly 2.6pt of the gain is better search per node and the other ~4.3pt is speed
  converting into depth. In self-play at equal work it is **58.3%** over 300 games (CI
  52.8–63.9) — unlike the eval work in the entry above, this kind of change does *not*
  cancel in self-play.

  What changed, in descending order of measured value:

  1. **~2.2× node rate**, from two batches of mechanical work. Hygiene: `bump()` moved above
     the TT probe (the probe's early returns were the one path through `negamax` that never
     touched the clock, so a cutoff-heavy subtree could run past the deadline), `>>>3`/`>>>2`
     for the packed-value divisions, lazy selection instead of an O(n²) insertion sort over
     ~76 moves, the eval cache from a `Map` to open-addressed typed arrays, and history from
     a `Map` to an `Int32Array` with a **separate lane per side to move** — a move's identity
     is side-independent in Trax but its value is not, and the two sides had been overwriting
     each other's credit. Then: cells re-encoded to **10 bits per axis** so a cell index fits
     in 2²⁰ and *can address a flat array*, which let every per-call `Set<number>` in
     `detectWins`/`walk`/`walkEval`/`moves` become a generation-stamped `Uint32Array`.
     Measured on 38 fixed positions from real analyst games, one process, both builds
     interleaved: **4.5k → 9.9k nodes/s**. In-match at `--budget 1500`: 8.8k → 19.3k nodes/s,
     11.1k → 23.4k nodes/move.
  2. **Partial-iteration retention.** `chooseMove` used to discard an aborted deepening
     iteration wholesale, which at 1500 ms and depth 5–6 routinely threw away half the think
     time — including root moves fully searched a ply deeper than anything it kept. It now
     keeps the completed prefix when ≥2 root moves settled. Sound because `rootMoves` is
     re-sorted best-first after every iteration, so the previous best is element 0 and always
     inside the prefix; "best of the prefix at depth d" therefore cannot be worse than "the
     previous choice re-judged at depth d". The decided-break deliberately does not run on
     partial scores (outside the first entry they are fail-soft upper bounds), and the
     reported `depth` still counts only *fully* completed iterations so the histogram stays
     honest. Gated on its own, paired against a throwaway snapshot holding the speed work
     alone (`--budget 1500`, 2000 games × 2 seeds, `--jobs 16`): **90.8% → 92.7%, +1.90pt
     (CI 0.22–3.58)**, at an identical node rate (19.5k vs 20.0k nodes/s) — so it is a
     search-quality gain, not a speed one, and it accounts for most of the +2.65pt equal-work
     delta. (Freezing a snapshot per stage is what makes this kind of attribution possible;
     only the pre-change `base` was worth keeping afterwards.)
  3. **TT mate scores stored as distance-from-node** rather than distance-from-root. Worth
     being precise about the severity: because Trax legality is history-free, "won for the
     side to move" is a property of the position alone, so the *verdict* was never corrupted —
     only the preference among wins and when the decided-break fires, i.e. dithering in an
     already-won position. Six lines; bundled, never gated alone.
  4. **Move ordering gets one piece of domain knowledge**: the number of occupied neighbours
     of the placement, which `FastBoard.moves` already computes to build its edge masks, so
     it is free. Weighted at 0.2 per neighbour — deliberately below the smallest history bump
     — it is a pure tie-break across the long tail of zero-history moves, which is exactly
     where ordering degenerates (every node on the frontier of a fresh iteration). Worth
     **3.2% fewer nodes** to complete depth 5. Small, but free and in the right direction.

  Tried and **rejected**, with the measurements:

  - **PVS at interior nodes.** Implemented with a float-safe null window (`alpha + 1e-9`, not
    `alpha + 1`: `loopThreat`'s 100/dist² produces differences far below 1, and an
    integer-width window silently reclassifies a genuine improvement as a fail-low). It cost
    **2.0% *more* nodes** to complete depth 5 and was flat on wall clock. With ordering this
    weak it pays more in re-searches than it saves, so it was dropped on the mechanism
    measurement rather than burning a 4000-game gate on it.
  - **Letting the neighbour-count prior compete with history.** Nodes to depth 5 relative to
    no prior: weight 0.2 → 0.968, 5 → 0.968, **100 → 1.035, 10 000 → 1.077**. History is
    learned from the search actually running; a static prior that outranks it makes ordering
    worse. Keep it a tie-break.
  - **Threat-proximity ordering** (the plan's "signal 2", exit cells being where 79% of real
    winning moves land) was **not attempted**: exit cells only exist inside `evalWhite`, which
    runs at *leaves*, and the interior nodes that need ordering are never evaluated at all —
    there is no cached parent eval to reuse. It becomes affordable only with maintained track
    endpoints; see the decision note below.

  **Where the losses now are** (`--diag`, at `--budget 1500`, 2000 games × 2 seeds):

  | bucket | base | now |
  |---|---|---|
  | losses | 281 | 143 |
  | `forkWidth == 1` — one unstoppable threat, needs depth | 158 | 69 |
  | `forkWidth >= 2` — a genuine fork, needs threat detection | 115 | 71 |

  This **overturns the previous entry's conclusion**. Depth halved the single-threat bucket
  (158 → 69) but barely touched forks (115 → 71), so the residue is now split roughly evenly
  rather than dominated by single threats. The previous entry's "one more ply of vision will
  not touch them" was measured before this speed-up and no longer describes the position.
  Symmetric threat detection — scoring the *non-mover's* verified threat, in the cheap form
  that counts distinct closing cells, since ≥2 distinct cells cannot be blocked by one
  placement — is therefore back on the table, and is the one lever aimed at the bucket that
  did not move. (It was rejected once before at −10pt, but on the *imprecise geometric* flag,
  in self-play, at 200 games — none of which is evidence about the verified form.)

  **Cost to be aware of:** the stamp lanes are three always-resident typed arrays over the
  2²⁰ cell space — ~20 MB, on top of the TT's 24 MB, in the browser worker. (The eval cache
  moving off a 250k-entry `Map` gives some of that back.) Halving them to `Uint16Array` with a
  wipe every 65 535 generations would be behaviour-identical and cost ~0.3 ms per wipe, i.e.
  nothing; it was left out of this round only because memory was not in its scope.

  **Update 2026-07-29: the fork bucket is not blind, and this recommendation was wrong.**
  See the entry below — symmetric verified threat detection was built, measured and
  rejected. Do not spend another round on it without reading that entry first.

  Also worth recording: **`--nodes` runs were never actually node-capped.** The shipped
  budget is 1500 ms and this search ran ~10k nodes/s, so a 20000-node cap bound only about
  half the moves and the clock cut the rest. That is harmless while comparing two builds of
  the same speed, and *fatal* to a comparison where one side is 2.2× faster — it would have
  handed the new build more nodes at nominally equal work. `scripts/vs-analyst.ts` now lifts
  the budget for a bare `--nodes` run. The shipped build measured 82.3% in the entry above but
  **85.3%** here under the historical `--nodes 20000 --budget 1500` config at `--jobs 30`; the
  3pt is the documented `--jobs` confound, not a change in the build.

- **2026-07-29 — symmetric verified threat detection: built, measured, REJECTED.** Nothing
  in `src/ai/` changed as a result except the stamp lanes below. Recorded at length because
  the previous entry recommended this as the next round's work, and the reasoning behind that
  recommendation turns out to be wrong in a way worth not rediscovering.

  **The idea.** `closesInOne` verification runs only for the side to move (the
  `color === fb.turn` guard in `evalWhite`); the opponent's threats are left to the
  22%-precision geometric flag. The proposal was to have the verifier return the *count of
  distinct closing cells* and run it for both sides, since two distinct cells cannot both be
  blocked by one placement. Aimed at the `forkWidth >= 2` losses, the bucket depth does not
  touch.

  **The proposed predicate does not work, and the reason is structural.** A converged loop
  threat has its two open ends one step apart, so it closes at *either* end — nearly every
  verified threat already has two distinct closing cells. Measured over 5545 positions from
  games lost to the analyst, against the ground truth "every legal move of the mover leaves
  the opponent a win-in-1":

  | predicate | fires | precision | recall |
  |---|---|---|---|
  | has any closing cell | 1445 | 11.6% | 90.8% |
  | **two distinct closing cells** (the proposal) | **1444** | **11.6%** | **90.8%** |
  | two closing cells >= 2 apart | 199 | 39.7% | 42.7% |
  | two closing cells **>= 3 apart** | 70 | **94.3%** | 35.7% |
  | two closing cells >= 6 apart | 40 | 95.0% | 20.5% |

  Counting closing cells is a slightly noisier copy of "has a threat" — 1444 fires against
  1445 — and at 11.6% it is *less* precise than the geometric flag it was meant to sharpen.
  **The separation is the entire signal**, and its threshold is derivable rather than tuned:
  a placement removes a closing cell by occupying it or by fixing an edge on a cell next to
  it, so one placement can answer both only when they are within 2. The measured cliff sits
  exactly there.

  **Even at 94% precision it is worth nothing.** Two paired 1700+ game gates at
  `--budget 1500`, `--jobs 16`, against a snapshot of the shipped build:

  | | paired delta | losses | `forkWidth == 1` | `forkWidth >= 2` | nps |
  |---|---|---|---|---|---|
  | unguarded fork pass | **−0.61pt** (CI −2.67–1.45) | 105 v 97 | 61 v 46 | 43 v 49 | 16.0k v 19.6k |
  | guarded by `threats >= 2` | **+0.12pt** (CI −1.56–1.79) | 113 v 115 | 56 v 63 | 55 v 50 | 18.0k v 19.7k |

  The first run cost 18% of the node rate; the fork bucket improved by 6 and the *other*
  bucket got 15 worse, because the lost depth costs more than the new vision buys. Gating the
  pass on the geometric two-threat count fixed the cost (the opponent has one flagged track
  in 28.1% of positions but two in only 2.4%, and gating loses no true forks at all — same 66
  hits, marginally better precision) and the result went to dead level. The fork bucket moved
  −6 then +5 across the two gates: noise.

  **Why level is the right answer, in hindsight.** The `loopDouble` cliff already scores
  exactly the positions the verified predicate fires on — a side holding two flagged threats
  — at ±10 000. Promoting those to ±400 000 when verification confirms them is a *magnitude*
  change on a signal the eval already had, and this log already records that magnitude
  changes buy nothing here (50 000 and 500 000 for `loopDouble`, no consistent gain). The
  search was already avoiding those positions. The 64% of real forks the predicate misses are
  the ones that would have mattered, and reaching them needs a better candidate generator,
  not a better test on the current one.

  So the previous entry's "the fork bucket needs better threat detection" was too quick: the
  bucket is not *blind*, it is already penalised. Whatever is causing those losses is
  upstream of the eval's verdict on the final position.

  **Kept from the round**, since all three are wins on their own terms:

  1. **`npm run bench`** (`scripts/bench.ts` + a committed 38-position fixture) — node rate
     and nodes-to-complete-depth on frozen positions. See its section above. Current
     effective branching factor: **5.8**.
  2. **`--sprt`** in `scripts/vs-analyst.ts`. Both gates above stopped themselves at ~85% of
     the requested games. Two bugs worth knowing, both fixed: shards cannot be told to stop
     over IPC (their game loop is synchronous, so the event never gets delivered — they stat
     a temp file instead), and the test must not fire below ~50 pairs (early paired
     differences are all zero, the sample variance is 0, and the LLR is ±infinity — this
     decided a match after 9 games).
  3. **Stamp lanes halved to `Uint16Array`** (`winStamp`, `moveStamp`, `evalStamp`): 20 MB →
     10 MB always-resident in the browser worker. Behaviour-identical, but *only* because
     `nextGen`'s wrap modulus moved to the array's own — at 32-bit width against 16-bit
     storage a stamp from generation `g` starts aliasing generation `g + 65536`, which is
     silently missed wins rather than merely redundant work. `tests/fastboard.test.ts` drives
     the wrap directly, since a real search would need 65 535 generations to reach it.

  Also tried and neutral: an edge pre-filter on the verifier's probe loop, skipping tiles
  `make()` would reject anyway. Exactly node-identical (572 289 nodes to complete depth 5,
  both builds) and worth ~0.7% wall clock. Not kept.

- **2026-07-29 — flat-grid FastBoard: 2.3× node rate, +2.60pt, PROMOTED.** `FastBoard.tiles`
  was the last hash on the hot path — a `Map<number, number>` probed several times per
  neighbour in `make`, the cascade, `moves`, `walk` and `evalWhite`. It is now an
  `Int8Array` over the whole 2²⁰ cell space (`grid`), plus an `Int32Array` stack of the
  occupied cells (`occ` / `occCount`) to iterate. A tile is stored as `index + 1` with 0
  reserved for empty, so a fresh zero-filled array is already an empty board and every
  emptiness test is a compare against 0; `CELL_CODE` and `CELL_OTHER_END` are the neighbour
  lookup tables re-indexed by grid value so the hot loops never shift the index back.

  | | Map | grid |
  |---|---|---|
  | nodes/s @ `--budget 1500` | 12.2k | **29.5k** (2.4×) |
  | nodes/s @ `--nodes 20000` | 10.1k | **23.1k** (2.29×) |
  | mean completed depth @ 1500 ms | 4.50 | **5.03** |
  | nodes to complete depth 3 / 4 / 5 | 13 784 / 150 845 / 469 434 | identical |

  **Gate** (`--agents prev,current --games 1000 --seeds 1,2 --budget 1500 --jobs 16 --diag`,
  against a temporary snapshot of `7df1817`, since deleted): **−2.60pt paired for `prev`**,
  95% CI −4.01 to −1.19. Losses 133 → 81 over 2000 games.

  | bucket | Map | grid |
  |---|---|---|
  | `forkWidth == 1` — needs depth | 76 | **32** |
  | `forkWidth >= 2` — needs threat detection | 55 | 47 |

  Half a ply cut the depth bucket by 58% and the fork bucket by 15%, which is the same split
  the previous round saw and further evidence that forks are not a depth problem.

  **This is a behaviour-neutral change, and that was checked rather than assumed.** The
  occupied stack reproduces the Map's insertion order exactly — placements always append and
  removals always come in exact reverse, which is the invariant `unmake` and `rollback`
  already relied on — so move generation order, and hence the whole search, is unchanged.
  Node counts on the bench fixture are byte-identical at every depth and at `--nodes 20000`
  (679 204 both arms), and a direct probe of the two `chooseMove`s over seeded self-play
  games produced identical transcripts.

  **Worth knowing for future gates: `--nodes` pairing against the analyst is not exact, even
  for a provably identical build.** The equal-work gate read −0.45pt (CI −2.00 to +1.10) —
  level, and correctly so, but it should have been exactly 0.00 and was not. The arms' game
  lengths and depth histograms differ slightly. It is not our side: with the search proven
  bit-identical above, the divergence is inside `suggest()`, which is not reproducible across
  the two arms despite `Math.random` being seeded per game per arm. So read an equal-work
  gate as "level within noise", never as an identity check — use `npm run bench` for that.

  **The one real hazard, and it is worth remembering if any flat array is added later.** On a
  Map, a lookup outside the board came back `undefined` and read as empty. On a flat grid a
  read at `y = 1024` silently aliases `(x + 1, y = 0)`. `moves()` reads the edge masks of a
  candidate cell, which sits *two* steps from an occupied one, so `COORD_LIMIT` dropped from
  511 to 510: occupied coordinates cap at ±509 and every index any loop here can form stays
  inside `[1, 1023]` on both axes, making the wrap unreachable rather than merely unlikely.
  `tests/fastboard.test.ts` pins the new limit.

- **2026-07-29 — incremental track endpoints: built, measured, REJECTED.** Nothing in
  `src/ai/` changed as a result. This was the last item standing in
  `scratch/ai-next-steps.md`, and it is worth reading before anything else is built on top
  of the track structure, because *both* halves of its pitch turn out to be wrong and the
  measurements say something about the bench fixture too.

  **What was built.** A rollback union-find over the degree-2 track graph, replacing the
  walks in `FastBoard.detectWins` and `search2.evalWhite`. A node is one color's segment of
  one placed tile, named `occIndex * 2 + color`; a placement seeds two singletons (the tile's
  two ports per color are their open ends) and unions each against the neighbour it now
  touches. Each root carries the component's two open ends — `cell * 4 + exitDir`, or `-1`
  for a closed loop — and its bounding box; merging two paths consumes one end from each and
  keeps the other two, which is the whole update rule. Union by size, **no path compression**
  (compression rewrites parents `unmake` would then have to restore), and an undo log of
  `(absorbed root, surviving root, its prior ends and box)` unwound in exact reverse
  placement order — the same invariant the occupied stack already relies on. It is correct:
  differential-tested against `wins.ts`'s `trace` at every ply of 40 random games, and the
  index rolls back to exactly what a fresh build of the same position holds.

  **Half one — it is not a speed win.** `prev` and `current` interleaved in one process, the
  bench fixture at 1000 ms: **28.3k → 27.9k nodes/s**, i.e. ~1.4% *slower*, and node counts
  byte-identical at every depth (13 784 / 150 845 / 469 434), so the eval and win detection
  were provably unchanged. The plan predicted a modest gain here; the flat-grid round had
  already taken the Map out of those walks, and what remained was cheap enough that `find()`
  plus the union bookkeeping on every `make()` costs about what it saves.

  **Half two — the proposed ordering signal does not exist.** "79% of real winning moves land
  on a track's exit cell, 21% adjacent" (recorded 2026-07-26) is true and useless. An open
  edge *is* an end of its component, so every empty cell beside a placed tile is some track's
  exit: the exit set is exactly the candidate set (25 of 25 on the first bench position). And
  the number of ends pointing at a cell is precisely the occupied-neighbour count `moves()`
  already computes for free — so the "signal" is a rename of the prior that has been in the
  ordering since 2026-07-27. Wiring it up as specified produced a **byte-identical search**.

  **What the index can say that nothing else can** is *which component* an end belongs to,
  and therefore how near one track is to closing on itself. Two more structural facts fell
  out, both measured over 2816 positions from the bench fixture and their children:

  - Separation **0** — a track's two ends pointing into one cell — **cannot occur**. Two
    same-colored edges facing an empty cell is a *forced* placement, so the cascade has
    already filled it. (This also means `loopThreat`'s `dist === 0` branch is dead code, and
    the eval's loop-threat flag is effectively "separation 1".)
  - Separation 1 happens 0.7 times per position; separation 2, **7.8** times. So separation 1
    is selective and separation 2 is nearly the whole board.

  As a move-ordering prior that is by a distance the best ordering signal this log has found.
  Nodes to complete depth 5 over the fixture, relative to no prior:

  | prior | ratio |
  |---|---|
  | separation 1 @ 0.2 / 0.45 / **0.9** / 2 / 20 | 0.926 / 0.858 / **0.851** / 0.865 / 0.862 |
  | separation 1 @ 0.9 **+ separation 2 @ 0.1** | **0.842** |
  | separation 1 @ 0.9 + separation 2 @ 0.3 | 0.855 |
  | (for comparison) the occupied-neighbour prior, 2026-07-27 | 0.968 |

  A broad plateau from 0.45 to 20, so the weight is not delicate, and — as with the neighbour
  prior — pushing it past history makes it slightly worse rather than better. At 0.9 + 0.1:
  **13 784 → 12 531, 150 845 → 133 520, 469 434 → 395 182 nodes**, i.e. −15.8% at depth 5,
  against 27.9k → 26.8k nodes/s. Mean completed depth at 1000 ms went 4.74 → **4.87**.

  **And it converted to nothing.** `--agents current,prev --games 1000 --seeds 1,2
  --budget 1500 --jobs 16 --diag --sprt`, 1675 paired games:

  | | current | prev |
  |---|---|---|
  | score | 96.4% | 96.2% |
  | paired delta | **+0.24pt** (95% CI −1.04 to +1.52) | |
  | nodes/s in match | 43.3k | 48.0k |
  | mean depth | 4.97 | 5.00 |
  | losses | 60 | 64 |
  | `forkWidth == 1` / `>= 2` | 33 / 27 | 26 / 35 |

  SPRT accepted H0. Note the in-match node-rate cost is **10%**, not the bench's 3.6%, and
  the extra depth the bench showed does not appear at all.

  **The most useful thing to take from this is about the fixture, not the change.**
  `scripts/bench-positions.json` is 38 positions at ply 20 *from games we lost*, chosen
  because that is where the tactical motifs are dense. A converging-track prior is precisely
  a tactical-motif detector, so a 15.8% node reduction there is close to a best case, and it
  did not survive contact with average positions. Ratios from that fixture are trustworthy
  for mechanism changes that touch every node equally (speed, the neighbour prior, PVS) and
  should be treated as an **upper bound** for anything that keys on a motif. If this is
  revisited, regenerate a second fixture from won and drawn games and require a change to
  clear both.

  **Also worth knowing before reusing any of this:**

  1. Ordering at depth-1 nodes matters more than the node counter suggests. `bump()` runs on
     `negamax` entry and a depth-1 child is a static eval, so ordering at the frontier saves
     *evals*, not nodes — yet gating the marking on `depth > 1` (which would have recovered
     most of the node-rate cost) gave back nearly the whole gain: 395 182 → 460 514. The
     frontier's cutoffs are what fill the history table that orders everything above it.
  2. The index frees 8 MB. `detectWins`' and `evalWhite`'s `CELL_SPACE * 2` visited lanes go
     away entirely, as does `CELL_OTHER_END` — nothing follows a track step by step any more.
     Against that it wants a `cell → occIndex` map (4 MB per board) to name nodes by
     occupancy slot. Roughly a wash, and not a reason to do it.
  3. Iterate components via the occupied list and `find()`, not by scanning for roots, if you
     want `evalWhite` to stay bit-identical: components are then visited in exactly the order
     the walk visited them, and the float sum — and every tie-break downstream of it — is
     unchanged. Scanning roots directly is cheaper but reorders the sum.

- **2026-07-30 — pricing the eval's terms from self-play outcomes.** A round about
  *instrumentation* first and changes second. Every eval round before it learned one bit per
  multi-hour paired gate; three of the last four spent that gate to learn "level". This builds
  an offline instrument that puts a number on a candidate term in **eval points** before any
  gate runs, then spends gates only on what it ranks highest.

  **The instrument.** `src/ai/features.ts` expresses a position as a feature vector whose
  first four slots *are* the hand eval's own components — `tempo`, `loop_sum`, `line_max`,
  `two_threat` — so that

  ```
  HAND · extractCore(fb) === evalWhite(fb)
  ```

  exactly (asserted in `tests/features.test.ts` over random positions). Three things follow
  from nesting rather than merely resembling the eval:

  1. It is a **drift-proof oracle**. The unmerged `ml` branch carried a hand-transcribed copy
     of the eval's weights, which went stale inside two weeks with nothing noticing.
  2. Every *other* slot's fitted weight reads as an **increment over what the eval already
     does** — the only interpretation that makes a price meaningful.
  3. Because `two_threat` is a slot, the fit prices the ±10 000 cliff **for free**.

  `scripts/gen-selfplay.ts` plays the shipped search against itself and records
  `{ result, features, hand }` per position; `scripts/train-eval.ts` fits `sigmoid(w·f)` to the
  result and reports Δ validation loss per candidate group. Corpus: **229 863 positions from
  15 428 self-play games** (`--nodes 5000 --margin 5`, 54 shards; the two shards covering
  games [5434, 5720) and [10868, 11154) were dropped after running 3× longer than the rest).
  Positions where the mover has a **verified win in one are excluded** — they are tactically
  settled, `evalWhite` *replaces* its score with ±`winInOne` there, and that exclusion is what
  makes the nesting identity exact. 4.4% of positions.

  **The price list.** Baseline is the *recorded* hand score at its own best temperature, so
  "did we beat the eval that shipped" is measured against the real thing. Groups are priced by
  leave-one-in ablation, not one joint fit: G3 reparametrises `loop_sum` and G4 reparametrises
  `line_max`, so jointly they would be collinear.

  | | Δ val-loss vs core | fitted weight (points) | hand | runtime |
  |---|---|---|---|---|
  | hand eval, as recorded | +0.01831 | — | — | — |
  | **core, refitted** | **(reference)** | tempo **39.5**, loop_sum **1.15**, line_max **0.00**, two_threat **65.6** | 10 / 1 / 1 / 10 000 | free |
  | G1 waiter asymmetry | **−0.00311** | waiter_open **+349**, waiter_blockable **−65** | none | expensive |
  | G2 cliff magnitude | +0.00001 | fork_count 8.7 | none | free |
  | G3 separation buckets | **−0.00474** | d1 50.7, d2 30.9, d3 1.0, far 62.3, blocked 4.9 | 100 / 25 / 11.1 / 100 / 0 | free |
  | G4 line aggregation | **−0.00463** | line2_s6 67.4, line1_s7 30.1, line_double 23.8, … | (max of axes) | free |
  | G5 fragmentation | −0.00176 | tracks +13.3 | none | free |

  Bar for "signal": 3× the larger of the fold-to-fold std of Δ and the within-fold
  per-position standard error, over 3 resampled 90/10 splits. **The plan's stated bar — 3× the
  seed-to-seed std of val loss — is the wrong test and was replaced.** A group's Δ is a
  *paired* quantity, both arms scored on the same positions, while the fold-to-fold spread of
  either arm's absolute loss is dominated by which positions landed in validation, and that
  cancels in the difference. Judging one against the other rejected differences that
  reproduced to three digits on all three folds. (Also worth knowing: with a *fixed* split the
  seeds differ only in minibatch order, the fits come out identical to five decimals, and the
  measured std is 0 — a bar of 0 waves everything through.)

  **The headline is not any of the groups.** Refitting the four weights the eval already has
  is worth **−0.0183**, four times the best new term, and costs nothing at runtime. What it
  says:

  - **`two_threat` is worth 66 points, not 10 000** — the eval overprices it by two orders of
    magnitude. This log records two sweeps of that cliff, to 50 000 and 500 000, both level,
    and concluded "magnitude is not the lever here". Both went *up*.
  - **`line_max` is worth 0.00.** As a single linear term the whole line-potential curve
    carries no outcome information once loop threats and tempo are accounted for. G4 recovers
    signal from the same geometry by splitting it into span × open-ends buckets, so the term's
    *shape* is what is wrong, not its existence.
  - **`tempo` is worth ~39, not 10** — and this one is a trap, see below.

  **Two findings that contradict the `ml` branch outright**, which is why its numbers were not
  reused as evidence: it priced `threat_waiter` at −98.5 ("a threat held by the side not to
  move is nearly neutralised") and `tracks` at −11.6. Over a corpus that knows about
  `closesInOne`, a waiter threat splits sharply by whether it can be answered — **+349** when
  its closing cells are ≥3 apart, **−65** when they are not — and `tracks` comes out *positive*
  and inside the noise bar.

  **Do not gate `tempo`.** It prices high and it is nearly a no-op in this search, for a
  structural reason worth keeping: `madeScore` evaluates at `depth <= 1`, so every leaf of one
  deepening iteration sits at the same ply and therefore has the same side to move, and the
  tempo term contributes the *same constant* to every leaf score it compares. Outcome
  regression rewards knowing who has the move; a fixed-depth negamax frontier cannot use it.
  **The general lesson: the price list values a term for prediction, and the search only cares
  about terms that vary across the leaves it is comparing.** Check that before spending a gate.

  ### The fork candidate generator, screened and retired

  `scratch/ai-next-steps.md`'s remaining top item was that the working fork predicate — a
  waiter threat whose two closing cells are ≥3 apart — is 94.3% precise at 35.7% recall, and
  "the missing 64% is the whole prize". `scripts/screen-fork.ts` measures candidate predicates
  against **exact ground truth** (the mover has no legal move that avoids leaving a win in one,
  computed by playing both plies on a FastBoard), over **10 639 positions from 379 games lost
  to the analyst**. 370 of them, 3.5%, are forked.

  | predicate | fires | precision | recall |
  |---|---|---|---|
  | any closing cell | 2797 | 12.1% | 91.6% |
  | one track, cells ≥3 apart | 7 | 28.6% | 0.5% |
  | **union of tracks, cells ≥3 apart** | 171 | **92.4%** | **42.7%** |
  | ≥2 threatening tracks | 166 | 95.2% | 42.7% |
  | union has no common answer | 191 | 83.8% | 43.2% |
  | one track has no common answer | 27 | 14.8% | 1.1% |

  The method reproduces the 2026-07-29 numbers (12.1%/91.6% against 11.6%/90.8% for "any
  closing cell"), which is what makes the rest of the table trustworthy. Three results:

  1. **The published ≥3-apart predicate is the *union* form, not the within-track form.**
     Within a single track it fires 7 times in 10 639 positions. Worth correcting, because the
     within-track reading is the natural one and it does nothing.
  2. **The separation test adds nothing over simply counting verified waiter threats.** ≥2
     threatening tracks: 166 fires, 95.2% precision, identical recall. The geometry was never
     the signal; having two answerable-only-one-at-a-time threats was.
  3. **No candidate breaks the recall ceiling, and the ceiling is structural.** Of the 370
     forked positions, the waiter holds **exactly one** verified threat in **48.9%** and two in
     42.7% (8.4% have none at all). A *fork* detector cannot exceed ~43% recall no matter how
     good it is, because half of these positions are not forks — they are single threats the
     mover cannot answer. Including the dominating-cell generalisation ("no single placement
     answers every closing cell", strictly stronger than any pairwise-distance test), which
     buys 0.5pt of recall for 8.6pt of precision.

  So "the missing 64% needs a better candidate generator" was a misdiagnosis: most of what is
  missing is not a fork. **Item 1 of `scratch/ai-next-steps.md` is retired**, and nothing was
  gated for it — G1 prices as signal but wants both-side `closesInOne`, whose runtime cost
  (−18% node rate) was already measured to eat more than the vision buys.

  ### Gate 1 — the fitted evaluation: measured, REJECTED (level)

  `src/ai/search2fit.ts` is the shipped search with `evalWhite`'s body replaced by
  `FIT_WEIGHTS · features` (`core+G3+G4`: tempo and the two-threat cliff, plus loop-separation
  and per-axis line buckets in place of the smooth 100/dist² and max-of-axes curves). Val loss
  **0.66610** against the shipped eval's **0.69225** — the best cheap configuration the
  instrument found.

  It **keeps the `closesInOne` mover short-circuit**, and that is the whole difference between
  this and the `ml` branch's abandoned attempt. A verified win in one is worth +2.0pt and is a
  *mechanism*, not a weight: no reweighting of positional features reproduces "the side to move
  can simply play it". The corpus excludes those positions for the same reason, so the fit has
  nothing to say about them and no business overwriting them.

  Node rate first, since that is what has eaten every previous eval gain — **and it is free**:

  | fixture | `pre` | `fit` |
  |---|---|---|
  | `losses` @ 1000 ms | 23.4k nodes/s, depth 4.63 | 23.5k nodes/s, depth 4.74 |
  | `mixed` @ 1000 ms | 17.9k nodes/s, depth 3.39 | 17.9k nodes/s, depth 3.34 |

  Gate (`--agents fit,pre --games 1000 --seeds 1,2 --budget 1500 --jobs 16 --diag --sprt`),
  923 paired games, SPRT stopped it at 902:

  | | `fit` | `pre` |
  |---|---|---|
  | score | 95.8% | 96.0% |
  | paired delta | **−0.22pt** (95% CI −1.97 to +1.53) | |
  | nodes/s in match | 45.3k | 43.4k |
  | mean depth | 4.95 | 4.95 |
  | losses | 39 | 37 |
  | `forkWidth == 1` / `>= 2` | 20 / 18 | 22 / 14 |

  **SPRT accepted H0.** Dead level, at an identical node rate and an identical depth.

  The interesting part is that it did not *lose*. An eval whose two-threat cliff is 135 instead
  of 10 000, whose loop curve is five bucket constants instead of 100/dist², and whose line
  curve is nine buckets instead of a max over two smooth axes — fitted to outcomes rather than
  guessed — plays exactly as well as the hand-written one. Together with the two magnitude
  sweeps in the 2026-07-25 entry, the reading is that **at depth ~5 the eval's fine structure
  is not what decides these games**; a 2.6pt improvement in val loss buys nothing on the board.
  What has ever moved the number is *depth* and *mechanism* (`closesInOne`, partial-iteration
  retention, the flat grid), never the shape of the positional curve.

  `src/ai/search2fit.ts`, `src/ai/eval-fit.ts` and the `fit` registry entries are kept: the
  instrument that produced them is reusable, and a future candidate term wants this arm to
  measure against. `tests/features.test.ts` pins the fused implementation to
  `FIT_WEIGHTS · extractCore` so it cannot rot silently — an off-by-one in a span bucket would
  otherwise invalidate a 2000-game gate invisibly.

  **Not done, deliberately:** a second-generation corpus. Same recipe, and the `ml` branch
  measured gen-2 as a wash on 2026-07-13.
