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

/** Adam on cross-entropy over `active` slots only; every other weight stays 0. */
function fit(data: Data, trainIdx: Uint32Array, active: readonly number[], o: Opts, seed: number): Float64Array {
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
        const err = sigmoid(score(data, i, w, active)) - data.y[i]
        for (const j of active) grad[j] += err * data.x[base + j]
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

interface FitResult {
  config: Config
  /** Val loss per training seed. */
  losses: number[]
  /** Rescaled (points) weights per training seed. */
  weights: Float64Array[]
}

function runConfig(data: Data, trainIdx: Uint32Array, valIdx: Uint32Array, config: Config, o: Opts): FitResult {
  const handStd = stdOn(data, trainIdx, null, config.active)
  const losses: number[] = []
  const weights: Float64Array[] = []
  for (const seed of o.seeds) {
    const w = fit(data, trainIdx, config.active, o, seed)
    losses.push(loss(data, valIdx, w, config.active, 1))
    const k = handStd / stdOn(data, trainIdx, w, config.active)
    weights.push(Float64Array.from(w, (x) => x * k))
  }
  return { config, losses, weights }
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

// Deterministic 90/10 split, from its **own** seed: every configuration and
// every training seed is scored on the same validation set, so a Δ between two
// configs is paired rather than confounded by a resplit.
const order = Uint32Array.from({ length: data.n }, (_, i) => i)
{
  const rand = mulberry32(o.splitSeed)
  for (let i = data.n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = order[i]
    order[i] = order[j]
    order[j] = t
  }
}
const nVal = Math.floor(data.n / 10)
const valIdx = order.slice(0, nVal)
const trainIdx = order.slice(nVal)

let wins = 0
let draws = 0
for (let i = 0; i < data.n; i++) {
  if (data.y[i] === 1) wins++
  else if (data.y[i] === 0.5) draws++
}
console.log(`loaded ${data.n} positions from ${o.data}/ (${trainIdx.length} train, ${valIdx.length} val)`)
console.log(`  labels: ${((100 * wins) / data.n).toFixed(1)}% White wins, ${((100 * draws) / data.n).toFixed(1)}% draws`)

const baseline = fitHandScale(data, trainIdx)
const baseVal = handLoss(data, valIdx, baseline.scale)
console.log(`  hand eval (recorded evalWhite, temperature ${baseline.scale.toExponential(2)}): val loss ${baseVal.toFixed(5)}`)
// The hand eval as a weight vector over this basis, for the record: the core
// config's fitted weights are directly comparable with these.
console.log(`  for comparison, HAND = ${CORE_SLOTS.map((j) => `${FEATURE_NAMES[j]} ${HAND[j]}`).join(', ')}`)

if (o.groups) {
  const core = runConfig(data, trainIdx, valIdx, coreConfig(), o)
  console.log('')
  console.log(`core (the four nested slots, refitted): val loss ${mean(core.losses).toFixed(5)} ± ${std(core.losses).toFixed(5)}`)
  console.log(`  weights: ${fmtWeights(core)}`)
  console.log(`  vs the hand eval: ${(mean(core.losses) - baseVal >= 0 ? '+' : '') + (mean(core.losses) - baseVal).toFixed(5)}`)

  console.log('')
  console.log('group                     Δ val-loss    bar (3σ)   verdict   cost')
  const results: FitResult[] = []
  for (const g of GROUPS) {
    const r = runConfig(data, trainIdx, valIdx, configFor([g.id]), o)
    results.push(r)
    const delta = mean(r.losses) - mean(core.losses)
    // The bar is 3× the *seed-to-seed* std of val loss, taken as the larger of
    // the two configs' — the honest noise floor for a difference between them.
    const bar = 3 * Math.max(std(r.losses), std(core.losses))
    const verdict = -delta > bar ? 'SIGNAL' : 'noise'
    console.log(
      `${`${g.id} ${g.name}`.padEnd(25)} ${(delta >= 0 ? '+' : '') + delta.toFixed(5)}      ` +
        `${bar.toFixed(5)}    ${verdict.padEnd(9)} ${g.cost}`,
    )
  }

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
const result = runConfig(data, trainIdx, valIdx, config, o)
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

// The mean over training seeds, not one seed's fit: the seeds differ only in
// minibatch order, so their spread is fitting noise and averaging it out is free.
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
