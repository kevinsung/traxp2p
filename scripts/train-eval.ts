#!/usr/bin/env -S npx tsx
/**
 * Prices evaluation terms against self-play outcomes.
 *
 * Dependency-free Adam logistic regression of `sigmoid(w · f)` on the game
 * result, over the corpus `scripts/gen-selfplay.ts` writes. Two modes:
 *
 *   npx tsx scripts/train-eval.ts [--data DIR] [--groups]      # the price list
 *   npx tsx scripts/train-eval.ts --fit G3,G5 [--out FILE]     # one fitted eval
 *
 * `--groups` (the default) is the instrument this exists for: it fits the core
 * alone, then the core plus each candidate group, and reports Δ val-loss and the
 * fitted weights **in eval points**. That is a price on a candidate term before
 * anyone spends a multi-hour paired gate on it — which is what the two rejected
 * rounds in docs/ai-arena.md cost.
 *
 * Four things that make the numbers mean what they look like:
 *
 * - **The basis nests the shipped eval** (see src/ai/features.ts), so a fitted
 *   weight on a candidate slot is an *increment* over today's eval, and the core
 *   config's own weights are directly comparable with `WEIGHTS`.
 * - **The baseline is the recorded hand score**, at its own best temperature
 *   (a 1-D scan), so "did we beat the hand eval" is measured against the eval
 *   that actually shipped rather than against a transcription of it.
 * - **Groups are priced one at a time, not jointly.** G3's buckets are a
 *   reparametrisation of `loop_sum` and G4's of `line_max`; in a joint fit they
 *   are collinear and an individual weight means little. `replaces` drops the
 *   core slot a group stands in for.
 * - **A group has to clear 3× the seed-to-seed std** of val loss to count as
 *   signal. If nothing clears it, that is the result — log it and stop, rather
 *   than gating on noise.
 *
 * A seed here resamples the **90/10 split as well as** the minibatch order, and
 * that is deliberate: with a single fixed split the seeds differ only in shuffle
 * order, the fits come out identical to five decimal places, the measured std is
 * 0 and the bar it feeds waves everything through. Resampling makes the spread an
 * estimate of the noise that actually threatens a conclusion. Comparisons stay
 * paired — a group and the core are always compared seed by seed, on the same
 * split — and everything is still reproducible, since the splits derive from the
 * seeds.
 *
 * Weights are rescaled by `std(hand) / std(w·f)` over *quiet* positions
 * (`|hand| < 1000`). Rescaling cannot change move ordering, and it is what keeps
 * `AI_LIMITS.topMargin` and the score display meaningful. The quiet mask
 * matters: without it the ±10 000 cliff positions dominate the standard
 * deviation, the scale collapses, and the root's tie-break pool goes with it.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { mulberry32 } from '../src/ai/arena'
import { CHEAP_COUNT, CORE_SLOTS, FEATURE_COUNT, FEATURE_NAMES, GROUPS, HAND } from '../src/ai/features'

interface Opts {
  data: string
  groups: boolean
  fit: string
  epochs: number
  seeds: number[]
  splitSeed: number
  l2: number
  lr: number
  batch: number
  out: string
}

function parseOpts(argv: string[]): Opts {
  const o: Opts = {
    data: 'data/selfplay-v2',
    groups: false,
    fit: '',
    epochs: 60,
    seeds: [1, 2, 3],
    splitSeed: 12345,
    l2: 1e-7,
    lr: 0.02,
    batch: 4096,
    out: '',
  }
  for (let i = 0; i < argv.length; i++) {
    const v = (): string => {
      const val = argv[++i]
      if (val === undefined) throw new Error(`missing value for ${argv[i - 1]}`)
      return val
    }
    switch (argv[i]) {
      case '--data': o.data = v(); break
      case '--groups': o.groups = true; break
      case '--fit': o.fit = v(); break
      case '--epochs': o.epochs = Number(v()); break
      case '--seeds': o.seeds = v().split(',').map(Number); break
      case '--split-seed': o.splitSeed = Number(v()); break
      case '--l2': o.l2 = Number(v()); break
      case '--lr': o.lr = Number(v()); break
      case '--batch': o.batch = Number(v()); break
      case '--out': o.out = v(); break
      default: throw new Error(`unknown option ${argv[i]}`)
    }
  }
  if (!o.groups && !o.fit) o.groups = true
  return o
}

// --- Data --------------------------------------------------------------------

interface Data {
  /** Feature vectors, row-major. */
  x: Float64Array
  /** Outcome from White's view: 1 White won, 0.5 draw, 0 Red won. */
  y: Float64Array
  /** The live `evalWhite` score at that position — baseline, mask and scale ref. */
  hand: Float64Array
  n: number
}

function loadData(dir: string): Data {
  const rows: number[][] = []
  const labels: number[] = []
  const hands: number[] = []
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.jsonl')) continue
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line) continue
      const { r, f, hand } = JSON.parse(line) as { r: number; f: number[]; hand: number }
      if (f.length !== FEATURE_COUNT) {
        throw new Error(`${file}: feature vector has ${f.length} entries, expected ${FEATURE_COUNT} — regenerate the corpus`)
      }
      rows.push(f)
      labels.push(r)
      hands.push(hand)
    }
  }
  if (rows.length === 0) throw new Error(`no .jsonl rows under ${dir}`)
  const n = rows.length
  const data: Data = { x: new Float64Array(n * FEATURE_COUNT), y: new Float64Array(n), hand: new Float64Array(n), n }
  for (let i = 0; i < n; i++) {
    data.x.set(rows[i], i * FEATURE_COUNT)
    data.y[i] = labels[i]
    data.hand[i] = hands[i]
  }
  return data
}

// --- Loss and fitting --------------------------------------------------------

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

function score(data: Data, i: number, w: Float64Array, active: readonly number[]): number {
  const base = i * FEATURE_COUNT
  let z = 0
  for (const j of active) z += w[j] * data.x[base + j]
  return z
}

/** Mean cross-entropy of `sigmoid(scale · w·f)` against the labels at `idx`. */
function loss(data: Data, idx: Uint32Array, w: Float64Array, active: readonly number[], scale: number): number {
  let sum = 0
  for (const i of idx) {
    const p = sigmoid(scale * score(data, i, w, active))
    const yi = data.y[i]
    sum -= yi * Math.log(p + 1e-12) + (1 - yi) * Math.log(1 - p + 1e-12)
  }
  return sum / idx.length
}

/** Mean cross-entropy of `sigmoid(scale · hand)` — the recorded eval's own loss. */
function handLoss(data: Data, idx: Uint32Array, scale: number): number {
  let sum = 0
  for (const i of idx) {
    const p = sigmoid(scale * data.hand[i])
    const yi = data.y[i]
    sum -= yi * Math.log(p + 1e-12) + (1 - yi) * Math.log(1 - p + 1e-12)
  }
  return sum / idx.length
}

/**
 * The temperature that makes the *fixed* hand scores best explain the data.
 * Without it the baseline would be measuring the eval's arbitrary scale rather
 * than its ordering, and would lose to anything.
 */
function fitHandScale(data: Data, idx: Uint32Array): { scale: number; loss: number } {
  let best = 1e-6
  let bestLoss = Infinity
  for (let e = -6; e <= 0; e += 0.125) {
    const s = 10 ** e
    const l = handLoss(data, idx, s)
    if (l < bestLoss) {
      bestLoss = l
      best = s
    }
  }
  return { scale: best, loss: bestLoss }
}

/**
 * Per-slot 1/RMS over `idx`, for fitting in scaled units.
 *
 * This is not cosmetic. The slots span four orders of magnitude — `loop_sum`
 * runs to ±100s of points while `two_threat` is ±1 — so the weight vector that
 * fits has entries around 1e-5, and Adam's step is ~`lr` regardless of gradient
 * size: at lr 0.02 it cannot resolve a 1e-5 weight at all, and the first run of
 * this trainer diverged to a val loss *above* ln 2 (worse than predicting 0.5)
 * for exactly that reason.
 *
 * RMS, not standard deviation: dividing is a pure rescale, which antisymmetry
 * survives, while *centering* would need an intercept and would break it. Every
 * slot has mean 0 over a color-balanced corpus anyway.
 */
function inverseRms(data: Data, idx: Uint32Array, active: readonly number[]): Float64Array {
  const inv = new Float64Array(FEATURE_COUNT).fill(1)
  for (const j of active) {
    let sum = 0
    for (const i of idx) {
      const v = data.x[i * FEATURE_COUNT + j]
      sum += v * v
    }
    const rms = Math.sqrt(sum / idx.length)
    inv[j] = rms > 0 ? 1 / rms : 1
  }
  return inv
}

/**
 * The temperature that best explains the data for these fitted weights, by the
 * same 1-D scan the hand baseline gets. Every configuration is scored at its own
 * best temperature, so a Δ val-loss between two of them is a difference in
 * *ordering quality* rather than in how precisely Adam happened to land the
 * overall scale. Scaling the whole vector cannot change move ordering, so this
 * costs the comparison nothing.
 */
function bestTemp(data: Data, idx: Uint32Array, w: Float64Array, active: readonly number[]): number {
  let best = 1
  let bestLoss = Infinity
  for (let e = -3; e <= 3; e += 0.0625) {
    const s = 10 ** e
    const l = loss(data, idx, w, active, s)
    if (l < bestLoss) {
      bestLoss = l
      best = s
    }
  }
  return best
}

/**
 * Adam on cross-entropy over `active` slots only; every other weight stays 0.
 * Fits in RMS-scaled units and returns weights in the original feature units.
 */
function fit(data: Data, trainIdx: Uint32Array, active: readonly number[], o: Opts, seed: number): Float64Array {
  const inv = inverseRms(data, trainIdx, active)
  const w = new Float64Array(FEATURE_COUNT)
  const m = new Float64Array(FEATURE_COUNT)
  const v = new Float64Array(FEATURE_COUNT)
  const grad = new Float64Array(FEATURE_COUNT)
  const beta1 = 0.9
  const beta2 = 0.999
  const order = trainIdx.slice()
  const rand = mulberry32(seed)
  let step = 0
  for (let epoch = 1; epoch <= o.epochs; epoch++) {
    // Fresh (deterministic) minibatch order each epoch.
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      const t = order[i]
      order[i] = order[j]
      order[j] = t
    }
    for (let start = 0; start < order.length; start += o.batch) {
      const end = Math.min(start + o.batch, order.length)
      for (const j of active) grad[j] = 0
      for (let k = start; k < end; k++) {
        const i = order[k]
        const base = i * FEATURE_COUNT
        let z = 0
        for (const j of active) z += w[j] * data.x[base + j] * inv[j]
        const err = sigmoid(z) - data.y[i]
        for (const j of active) grad[j] += err * data.x[base + j] * inv[j]
      }
      const size = end - start
      step++
      for (const j of active) {
        const g = grad[j] / size + o.l2 * w[j]
        m[j] = beta1 * m[j] + (1 - beta1) * g
        v[j] = beta2 * v[j] + (1 - beta2) * g * g
        const mh = m[j] / (1 - beta1 ** step)
        const vh = v[j] / (1 - beta2 ** step)
        w[j] -= (o.lr * mh) / (Math.sqrt(vh) + 1e-8)
      }
    }
  }
  // Back to the original feature units: z = Σ wₛ·(x·inv) = Σ (wₛ·inv)·x.
  for (const j of active) w[j] *= inv[j]
  return w
}

/** Std of `w·f` over the quiet positions in `idx`; `null` weights means the hand score. */
function stdOn(data: Data, idx: Uint32Array, w: Float64Array | null, active: readonly number[]): number {
  let n = 0
  let mean = 0
  let m2 = 0
  for (const i of idx) {
    if (Math.abs(data.hand[i]) >= QUIET) continue
    const z = w ? score(data, i, w, active) : data.hand[i]
    n++
    const d = z - mean
    mean += d / n
    m2 += d * (z - mean)
  }
  return Math.sqrt(m2 / n)
}

/**
 * A position is quiet when the hand eval sees no near-decisive threat. The bound
 * is `lineDouble`/`loopDouble` = 10 000, so anything under 1000 is "no cliff in
 * sight" with an order of magnitude of margin.
 */
const QUIET = 1000

// --- Statistics --------------------------------------------------------------

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Sample std (n−1); 0 for a single sample. */
function std(xs: readonly number[]): number {
  if (xs.length < 2) return 0
  const mu = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1))
}

// --- Configurations ----------------------------------------------------------

interface Config {
  label: string
  active: number[]
  cost: 'free' | 'verified'
}

/** The core alone: the four slots the hand eval spends its weight on. */
const coreConfig = (): Config => ({ label: 'core', active: [...CORE_SLOTS], cost: 'free' })

/** Core + the named groups, with each group's `replaces` slots dropped. */
function configFor(ids: readonly string[]): Config {
  const groups = ids.map((id) => {
    const g = GROUPS.find((x) => x.id === id)
    if (!g) throw new Error(`unknown group "${id}"; have: ${GROUPS.map((x) => x.id).join(', ')}`)
    return g
  })
  const dropped = new Set(groups.flatMap((g) => g.replaces))
  const active = [...CORE_SLOTS.filter((s) => !dropped.has(s)), ...groups.flatMap((g) => g.slots)]
  return {
    label: `core+${ids.join('+')}`,
    active,
    cost: groups.some((g) => g.cost === 'verified') ? 'verified' : 'free',
  }
}

/** One seed's resampled 90/10 split. */
interface Fold {
  seed: number
  trainIdx: Uint32Array
  valIdx: Uint32Array
}

function makeFold(data: Data, seed: number, splitSeed: number): Fold {
  const order = Uint32Array.from({ length: data.n }, (_, i) => i)
  const rand = mulberry32(splitSeed + seed)
  for (let i = data.n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
  const nVal = Math.floor(data.n / 10)
  return { seed, valIdx: order.slice(0, nVal), trainIdx: order.slice(nVal) }
}

interface FitResult {
  config: Config
  /** Val loss per fold, in fold order — so two configs' entries pair. */
  losses: number[]
  /** Rescaled (points) weights per fold. */
  weights: Float64Array[]
  /** The fitted weights and temperature per fold, for per-position comparisons. */
  fits: Array<{ w: Float64Array; temp: number }>
}

function runConfig(data: Data, folds: readonly Fold[], config: Config, o: Opts): FitResult {
  const losses: number[] = []
  const weights: Float64Array[] = []
  const fits: Array<{ w: Float64Array; temp: number }> = []
  for (const fold of folds) {
    const w = fit(data, fold.trainIdx, config.active, o, fold.seed)
    const temp = bestTemp(data, fold.trainIdx, w, config.active)
    losses.push(loss(data, fold.valIdx, w, config.active, temp))
    fits.push({ w, temp })
    const k = stdOn(data, fold.trainIdx, null, config.active) / stdOn(data, fold.trainIdx, w, config.active)
    weights.push(Float64Array.from(w, (x) => x * k))
  }
  return { config, losses, weights, fits }
}

/** Cross-entropy of one position under one fit. */
function rowLoss(data: Data, i: number, f: { w: Float64Array; temp: number }, active: readonly number[]): number {
  const p = sigmoid(f.temp * score(data, i, f.w, active))
  const yi = data.y[i]
  return -(yi * Math.log(p + 1e-12) + (1 - yi) * Math.log(1 - p + 1e-12))
}

/**
 * Standard error of one fold's Δ val-loss, computed **per validation position**.
 *
 * The reason the bar needs this: a group's Δ is a *paired* quantity — both arms
 * are scored on the same positions — while the fold-to-fold spread of either
 * arm's absolute loss is dominated by which positions landed in the validation
 * set, and that noise cancels in the difference. Judging a paired Δ against
 * unpaired spread is a category error, and it rejected differences here that
 * reproduced to three digits on every fold. So the bar takes both: the Δ has to
 * be reproducible across resamples *and* significant within a fold.
 */
function pairedStderr(data: Data, fold: Fold, a: FitResult, b: FitResult, index: number): number {
  let n = 0
  let mean = 0
  let m2 = 0
  for (const i of fold.valIdx) {
    const d = rowLoss(data, i, a.fits[index], a.config.active) - rowLoss(data, i, b.fits[index], b.config.active)
    n++
    const delta = d - mean
    mean += delta / n
    m2 += delta * (d - mean)
  }
  return Math.sqrt(m2 / n / n)
}

/** The mean rescaled weight of each active slot, over the training seeds. */
function meanWeights(r: FitResult): Map<number, number> {
  const out = new Map<number, number>()
  for (const j of r.config.active) out.set(j, mean(r.weights.map((w) => w[j])))
  return out
}

const fmtWeights = (r: FitResult): string =>
  [...meanWeights(r)].map(([j, w]) => `${FEATURE_NAMES[j]} ${w.toFixed(2)}`).join(', ')

// --- Main --------------------------------------------------------------------

const o = parseOpts(process.argv.slice(2))
const data = loadData(o.data)

const folds = o.seeds.map((seed) => makeFold(data, seed, o.splitSeed))

let wins = 0
let draws = 0
for (let i = 0; i < data.n; i++) {
  if (data.y[i] === 1) wins++
  else if (data.y[i] === 0.5) draws++
}
console.log(
  `loaded ${data.n} positions from ${o.data}/ ` +
    `(${folds.length} folds of ${folds[0].trainIdx.length} train / ${folds[0].valIdx.length} val, seeds ${o.seeds.join(',')})`,
)
console.log(`  labels: ${((100 * wins) / data.n).toFixed(1)}% White wins, ${((100 * draws) / data.n).toFixed(1)}% draws`)

// The baseline is per fold too, so "beat the hand eval" is a paired claim.
const baseScales = folds.map((f) => fitHandScale(data, f.trainIdx).scale)
const baseLosses = folds.map((f, i) => handLoss(data, f.valIdx, baseScales[i]))
const baseVal = mean(baseLosses)
console.log(
  `  hand eval (recorded evalWhite at its own temperature ${baseScales[0].toExponential(2)}): ` +
    `val loss ${baseVal.toFixed(5)} ± ${std(baseLosses).toFixed(5)}`,
)
// The hand eval as a weight vector over this basis, for the record: the core
// config's fitted weights are directly comparable with these.
console.log(`  for comparison, HAND = ${CORE_SLOTS.map((j) => `${FEATURE_NAMES[j]} ${HAND[j]}`).join(', ')}`)

const signed = (x: number): string => (x >= 0 ? '+' : '') + x.toFixed(5)

if (o.groups) {
  const core = runConfig(data, folds, coreConfig(), o)
  console.log('')
  console.log(`core (the four nested slots, refitted): val loss ${mean(core.losses).toFixed(5)} ± ${std(core.losses).toFixed(5)}`)
  console.log(`  weights: ${fmtWeights(core)}`)
  console.log(`  vs the hand eval: ${signed(mean(core.losses) - baseVal)}`)

  console.log('')
  console.log('group                     Δ val-loss    bar (3σ)    per-fold Δ                  verdict   cost')
  const results: FitResult[] = []
  for (const g of GROUPS) {
    const r = runConfig(data, folds, configFor([g.id]), o)
    results.push(r)
    const perFold = r.losses.map((l, i) => l - core.losses[i])
    const delta = mean(perFold)
    // Reproducible across resamples *and* significant within a fold; see
    // pairedStderr for why the fold-to-fold spread alone is the wrong test.
    const acrossFolds = std(perFold)
    const withinFold = mean(folds.map((f, i) => pairedStderr(data, f, r, core, i)))
    const bar = 3 * Math.max(acrossFolds, withinFold)
    const verdict = -delta > bar ? 'SIGNAL' : 'noise'
    console.log(
      `${`${g.id} ${g.name}`.padEnd(25)} ${signed(delta)}      ${bar.toFixed(5)}     ` +
        `${perFold.map(signed).join(' ').padEnd(27)} ${verdict.padEnd(9)} ${g.cost}`,
    )
  }
  console.log('  (bar = 3× max of the fold-to-fold std of Δ and the within-fold per-position stderr)')

  console.log('')
  console.log('fitted weights, in eval points (mean over training seeds):')
  for (const r of results) {
    console.log(`  ${r.config.label.padEnd(9)} val loss ${mean(r.losses).toFixed(5)} ± ${std(r.losses).toFixed(5)}`)
    for (const [j, w] of meanWeights(r)) {
      const handW = HAND[j]
      const note = handW !== 0 ? `   (hand ${handW})` : ''
      console.log(`    ${FEATURE_NAMES[j].padEnd(18)} ${w.toFixed(2).padStart(12)}${note}`)
    }
  }
  process.exit(0)
}

// --- --fit: one configuration, optionally written out ------------------------

const ids = o.fit === 'core' ? [] : o.fit.split(',').map((s) => s.trim()).filter(Boolean)
const config = ids.length === 0 ? coreConfig() : configFor(ids)
const result = runConfig(data, folds, config, o)
console.log('')
console.log(`${config.label}: val loss ${mean(result.losses).toFixed(5)} ± ${std(result.losses).toFixed(5)} (${config.cost})`)
for (const [j, w] of meanWeights(result)) {
  console.log(`  ${FEATURE_NAMES[j].padEnd(18)} ${w.toFixed(2).padStart(12)}${HAND[j] !== 0 ? `   (hand ${HAND[j]})` : ''}`)
}

if (!o.out) process.exit(0)

// The written module is what a runtime eval dots against, so it must not depend
// on a slot the runtime cannot afford to compute.
const expensive = config.active.filter((j) => j >= CHEAP_COUNT)
if (expensive.length > 0) {
  throw new Error(
    `refusing to write ${o.out}: ${expensive.map((j) => FEATURE_NAMES[j]).join(', ')} ` +
      'need both-side closesInOne, which is not free at runtime (see docs/ai-arena.md, 2026-07-29)',
  )
}

// The mean over folds, not one fold's fit: their spread is resampling noise, and
// averaging it out costs nothing since every fold trains on 90% of the corpus.
const w = new Float64Array(FEATURE_COUNT)
for (const j of config.active) w[j] = mean(result.weights.map((x) => x[j]))
const body = [...w].map((x, j) => `  ${x.toFixed(4)}, // ${FEATURE_NAMES[j]}`).join('\n')
writeFileSync(
  o.out,
  `/**
 * Fitted evaluation weights: score = FIT_WEIGHTS · (the feature basis of
 * src/ai/features.ts). Cheap slots only; the verified ones are 0.
 *
 * GENERATED FILE — written by \`npx tsx scripts/train-eval.ts --fit ${o.fit} --out ${o.out}\`.
 * Edit the trainer, never this.
 *
 * Provenance: logistic regression on ${data.n} self-play positions (${o.data},
 * ${new Date().toISOString().slice(0, 10)}), config ${config.label}, ${o.seeds.length} training seeds.
 * Val loss ${mean(result.losses).toFixed(5)} against ${baseVal.toFixed(5)} for the shipped hand eval
 * at its best temperature. Rescaled to the hand eval's score range over quiet
 * positions (|hand| < ${QUIET}), which cannot change move ordering.
 */
import { FEATURE_COUNT } from './features'

// prettier-ignore
export const FIT_WEIGHTS = Float64Array.from([
${body}
])

if (FIT_WEIGHTS.length !== FEATURE_COUNT) {
  throw new Error(\`FIT_WEIGHTS has \${FIT_WEIGHTS.length} entries but FEATURE_COUNT is \${FEATURE_COUNT}\`)
}
`,
)
console.log(`\nwrote ${o.out}`)
