import { existsSync, promises as fs } from 'fs';
import path from 'path';
import type {
  BenchmarkResults,
  HostProvenance,
  TimerStatistics,
} from '../../../../shared/constants/benchmarks';
import { SAMPLE_EXCLUSION } from './constants';
import { convertTimerStatisticsToBenchmarkResults } from './runner';
import type { PreparedWebVitalsRun } from './runner';
import {
  aggregateWebVitals,
  calculateTimerStatistics,
  MAX_TOTAL_DURATION_MS,
  WEB_VITALS_NUMERIC_KEYS,
} from './statistics';
import type { PreparedMetricSample } from './statistics';

/**
 * Base and head builds paired inside one job: ADR 0072's paired comparator.
 *
 * Under {@link PAIRED} the runner runs a flow on two builds in one job, base
 * and head. It first runs one warm-up run of each build, discarded, and then
 * the measured runs in the order base, head, head, base, or head, base, base,
 * head where the job asks for it (ADR 0072, sample preparation and stage 4,
 * "Dependence"). Half the jobs lead with each build, so both a linear drift
 * and a first-position effect cancel. A run is the flow's iterations on one
 * build; the paired statistic takes one value per measured run, the mean of
 * its iterations.
 *
 * The browser loads the extension from `<cwd>/dist/<browser>`
 * (`webdriver/chrome.js`), so before each run `dist` is pointed at that
 * run's build by a symlink, and afterwards put back as it was. A `dist` that
 * is a real directory is refused rather than moved. Every iteration already
 * starts its own browser, so no browser session spans both builds. Each run
 * is also its own process (`run-benchmark.ts`), because the e2e helpers read
 * a build's `manifest.json` once per process and write it back into
 * whichever build `dist` points at (`set-manifest-flags.ts`, `readManifest`):
 * in one process the second build would get the first build's manifest.
 *
 * Only Chrome is paired. Firefox installs the extension from an `.xpi` cached
 * by the path of `dist/firefox` and its manifest's hash (`helpers/xpi.ts`,
 * `getOrBuildXpi`), so with base and head manifests alike the second build
 * would reuse the first build's archive.
 */

/** Run base and head builds in one job when set to `1`. */
export const PAIRED = 'BENCHMARK_PAIRED';

/**
 * Which build leads: `base-head-head-base`, the default, or
 * `head-base-base-head`. The job sets it so that half the jobs lead with each.
 */
export const PAIRED_ORDER = 'BENCHMARK_PAIRED_ORDER';

/** The base build's `dist` directory, the one holding `chrome/`. */
export const PAIRED_BASE_DIST = 'BENCHMARK_PAIRED_BASE_DIST';

/** The head build's `dist` directory, the one holding `chrome/`. */
export const PAIRED_HEAD_DIST = 'BENCHMARK_PAIRED_HEAD_DIST';

export const PAIRED_ORDERS = [
  'base-head-head-base',
  'head-base-base-head',
] as const;

export type PairedOrder = (typeof PAIRED_ORDERS)[number];

export type PairedBuild = 'base' | 'head';

/** A warm-up run, discarded, or a measured run. */
export type PairedPhase = 'warmup' | 'measured';

export type PairedConfig = {
  order: PairedOrder;
  /** Absolute path of each build's `dist` directory. */
  dist: Record<PairedBuild, string>;
};

/**
 * One run of a paired job. `host` is the machine and in-page CPU probe
 * readings the run's own process recorded, and `error` why the run gave no
 * values, or why every iteration failed. On a measured run, a key of the
 * run's results that the merge does not know, and that is not a per-iteration
 * record, is kept here under its own name, as is a base run's `webVitals`.
 */
export type PairingRun = {
  build: PairedBuild;
  position: number;
  host?: HostProvenance;
  error?: string;
  [key: string]: unknown;
};

/**
 * The `pairing` key of a paired job's results (the step-work contract,
 * section 5). `runs` lists the measured runs only, `position` 0 to 3 in the
 * order they ran; `warmup` lists the warm-up runs, `position` 0 and 1 in the
 * order they ran.
 */
export type Pairing = {
  order: PairedOrder;
  warmup: PairingRun[];
  runs: PairingRun[];
};

/** An iteration's value in a paired job, with the build and the run it came from. */
export type PairedMetricSample = PreparedMetricSample & {
  build: PairedBuild;
  position: number;
};

export type PairedBenchmarkResults = BenchmarkResults & {
  pairing: Pairing;
  baseValues?: Record<string, PairedMetricSample[]>;
  [key: string]: unknown;
};

/** What one run gave: its results, or why it gave none. */
export type PairedRunOutcome = {
  build: PairedBuild;
  position: number;
  result?: BenchmarkResults & Record<string, unknown>;
  error?: string;
};

/** Every run of a paired job, warm-up and measured, each in the order it ran. */
export type PairedJobOutcomes = {
  warmup: PairedRunOutcome[];
  runs: PairedRunOutcome[];
};

/**
 * @param env - The environment to read.
 * @returns Whether {@link PAIRED} asks for a paired job.
 */
export function isPairedRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PAIRED] === '1';
}

/**
 * Read and check a paired job's settings.
 *
 * @param env - The environment to read.
 * @param cwd - What relative `dist` paths are resolved against.
 * @returns The order and each build's `dist` directory.
 * @throws When the order is not one of {@link PAIRED_ORDERS}, a `dist` path is
 * missing or holds no `chrome/manifest.json`, or the browser is not Chrome.
 */
export function readPairedConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): PairedConfig {
  const browser = env.SELENIUM_BROWSER ?? 'chrome';
  if (browser !== 'chrome') {
    throw new Error(
      `${PAIRED}=1 runs on Chrome only, not ${browser}: Firefox reuses an .xpi cached by the path of dist/firefox and its manifest's hash, so the second build could run the first build's archive`,
    );
  }

  const order = env[PAIRED_ORDER] || PAIRED_ORDERS[0];
  if (!(PAIRED_ORDERS as readonly string[]).includes(order)) {
    throw new Error(
      `${PAIRED_ORDER} is "${order}"; it must be one of ${PAIRED_ORDERS.join(', ')}`,
    );
  }

  const readDist = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`${PAIRED}=1 needs ${name}, a build's dist directory`);
    }
    const dist = path.resolve(cwd, value);
    if (!existsSync(path.join(dist, 'chrome', 'manifest.json'))) {
      throw new Error(
        `${name} is ${dist}, which holds no chrome/manifest.json; it must be a build's dist directory`,
      );
    }
    return dist;
  };

  return {
    order: order as PairedOrder,
    dist: {
      base: readDist(PAIRED_BASE_DIST),
      head: readDist(PAIRED_HEAD_DIST),
    },
  };
}

/**
 * @param order - A paired order.
 * @returns The build of each measured run, in the order they run.
 */
export function pairedSequence(order: PairedOrder): PairedBuild[] {
  return order.split('-') as PairedBuild[];
}

/**
 * The warm-up runs come first, one of each build, in the order the measured
 * runs first reach each build, so that across the two orders they mirror.
 *
 * @param order - A paired order.
 * @returns The build of each warm-up run, in the order they run.
 */
export function pairedWarmupSequence(order: PairedOrder): PairedBuild[] {
  return pairedSequence(order).slice(0, 2);
}

/** What `dist` was before a paired job pointed it at a build. */
export type DistState =
  | { kind: 'absent' }
  | { kind: 'symlink'; target: string };

/**
 * @param link - The `dist` path the browser loads from.
 * @returns Whether it is absent or a symlink, and where the symlink points.
 * @throws When `dist` is a real directory or file: a paired job points `dist`
 * at each build in turn and does not move what is already there.
 */
export async function readDistState(link: string): Promise<DistState> {
  let stats;
  try {
    stats = await fs.lstat(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    throw error;
  }
  if (!stats.isSymbolicLink()) {
    throw new Error(
      `${link} is a real ${stats.isDirectory() ? 'directory' : 'file'}. A paired job points it at each build in turn by a symlink and will not move it: put the builds elsewhere and pass their paths in ${PAIRED_BASE_DIST} and ${PAIRED_HEAD_DIST}`,
    );
  }
  return { kind: 'symlink', target: await fs.readlink(link) };
}

/**
 * Point `dist` at a build, replacing the symlink in one rename.
 *
 * @param link - The `dist` path the browser loads from.
 * @param target - The build's `dist` directory.
 */
export async function pointDistAt(link: string, target: string): Promise<void> {
  const temporary = `${link}.paired-${process.pid}`;
  await fs.rm(temporary, { force: true });
  await fs.symlink(target, temporary, 'dir');
  await fs.rename(temporary, link);
}

/**
 * Put `dist` back as it was before the paired job.
 *
 * @param link - The `dist` path the browser loads from.
 * @param state - What {@link readDistState} read before the job.
 */
export async function restoreDistState(
  link: string,
  state: DistState,
): Promise<void> {
  if (state.kind === 'symlink') {
    await pointDistAt(link, state.target);
    return;
  }
  const current = await readDistState(link);
  if (current.kind === 'symlink') {
    await fs.unlink(link);
  }
}

/**
 * Run a paired job: the two warm-up runs, then the four measured runs, `dist`
 * pointed at each run's build, and put `dist` back afterwards, even when a run
 * throws.
 *
 * @param options - The job.
 * @param options.config - The order and each build's `dist` directory.
 * @param options.distLink - The `dist` path the browser loads from.
 * @param options.runOne - Runs one run on the build `dist` points at. A run
 * that throws is recorded with its error and the job goes on.
 * @returns Each run's outcome, warm-up and measured apart, in the order they
 * ran.
 */
export async function runPairedRuns({
  config,
  distLink,
  runOne,
}: {
  config: PairedConfig;
  distLink: string;
  runOne: (
    build: PairedBuild,
    position: number,
    phase: PairedPhase,
  ) => Promise<BenchmarkResults & Record<string, unknown>>;
}): Promise<PairedJobOutcomes> {
  const before = await readDistState(distLink);
  const job: PairedJobOutcomes = { warmup: [], runs: [] };
  const phases: [PairedPhase, PairedBuild[], PairedRunOutcome[]][] = [
    ['warmup', pairedWarmupSequence(config.order), job.warmup],
    ['measured', pairedSequence(config.order), job.runs],
  ];
  try {
    for (const [phase, sequence, outcomes] of phases) {
      for (const [position, build] of sequence.entries()) {
        const label =
          phase === 'warmup'
            ? `paired warm-up run ${position}, discarded`
            : `paired run ${position} of ${config.order}`;
        await pointDistAt(distLink, config.dist[build]);
        console.log(
          `[benchmark] ${label}: the ${build} build, ${config.dist[build]}`,
        );
        try {
          outcomes.push({
            build,
            position,
            result: await runOne(build, position, phase),
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(`[benchmark] ${label} failed: ${message}`);
          outcomes.push({ build, position, error: message });
        }
      }
    }
  } finally {
    await restoreDistState(distLink, before);
  }
  return job;
}

const IDENTITY_KEYS = [
  'testTitle',
  'persona',
  'benchmarkType',
  'platform',
  'buildType',
] as const;

/** Keys the merge builds itself, from the head build's values. */
const SUMMARY_KEYS = new Set<string>([
  'mean',
  'min',
  'max',
  'stdDev',
  'p75',
  'p95',
  'trimmedCount',
  'outliers',
]);

type IterationRecord = { iteration: number } & Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIterationEntries(value: unknown): value is IterationRecord[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isPlainObject(entry) && typeof entry.iteration === 'number',
    )
  );
}

/**
 * Whether a results key is a per-iteration record keyed by series or step,
 * the shape of `values` and of the contract's `stepTerms` and
 * `requestSequence`: `{ [key]: Array<{ iteration, ... }> }`.
 *
 * @param value - The key's value.
 */
function isPerIterationRecord(
  value: unknown,
): value is Record<string, IterationRecord[]> {
  return (
    isPlainObject(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(isIterationEntries)
  );
}

/**
 * Number one measured run's iterations within the job and say which build
 * and run each came from. The runner flags each run's first iteration as its
 * warm-up; in a paired job the warm-up runs take its place (ADR 0072 L32), so
 * that flag is dropped and any other is kept.
 *
 * @param entries - The run's entries, numbered within the run.
 * @param outcome - The run.
 * @param offset - The job's iteration number of the run's first iteration.
 * @param withPosition - Whether to add `position`. `webVitals.runs` gets
 * `build` alone: the window loaders read every numeric key of an entry there
 * as a series.
 */
function tagIterations<TEntry extends IterationRecord>(
  entries: TEntry[],
  outcome: PairedRunOutcome,
  offset: number,
  withPosition = true,
): (TEntry & { build: PairedBuild; position?: number })[] {
  return entries.map(({ excluded, ...entry }) => ({
    ...(entry as TEntry),
    iteration: offset + (entry as TEntry).iteration,
    ...(excluded !== undefined &&
      excluded !== SAMPLE_EXCLUSION.WarmUp && { excluded }),
    build: outcome.build,
    ...(withPosition && { position: outcome.position }),
  }));
}

/**
 * The head build's statistics, from its values, as the runner computes them
 * for a job (`runBenchmarkWithIterations`): flagged values left out, then the
 * sanity, IQR and z-score filters. One difference: the runner lets a timer
 * that carries a unit be 0 and holds the rest to at least 1 ms, and the
 * results do not record the unit, so here every timer but `total` may be 0.
 *
 * @param values - The head build's values.
 */
function headTimerStatistics(
  values: Record<string, PairedMetricSample[]>,
): TimerStatistics[] {
  return Object.entries(values).map(([id, samples]) =>
    calculateTimerStatistics(
      id,
      samples.map((sample) => sample.value),
      {
        iterations: samples.map((sample) => sample.iteration),
        exclusions: samples.map((sample) => sample.excluded),
        ...(id === 'total'
          ? { maxDurationMs: MAX_TOTAL_DURATION_MS }
          : { minDurationMs: 0 }),
      },
    ),
  );
}

/**
 * The run's error: why it gave no results, or why every iteration failed.
 *
 * @param outcome - The run.
 */
function runError(outcome: PairedRunOutcome): string | undefined {
  return outcome.error ?? outcome.result?.error;
}

/**
 * Merge a paired job's runs into one results entry (the step-work contract,
 * section 5).
 *
 * - `values` holds the head build's iterations alone, so a reader written
 * before pairing reads the head as before; `baseValues` holds the base
 * build's, in the same shape. Each entry carries its `build` and its run's
 * `position`.
 * - Every other per-iteration record (`stepTerms`, `requestSequence`), and
 * `lever.measured`, hold both builds, each entry with `build` and `position`.
 * - Iterations are numbered within the job's measured runs: run `position`'s
 * iteration `i` is `position * iterationsPerRun + i`.
 * - `webVitals` is the head build's: its runs, each with `build`, and their
 * aggregate. Each base run's `webVitals` stays on its `pairing.runs` entry.
 * - The statistics (`mean`, `p75` and the rest) are the head build's.
 * - `pairing` gives the order, the warm-up runs under `warmup` and the
 * measured runs under `runs`, each with its own `host` readings and its
 * `error` where it has one. Nothing else of a warm-up run is kept.
 * - `error` is set when any run, warm-up or measured, gave no values or every
 * iteration of it failed, naming the runs.
 *
 * @param options - The job.
 * @param options.order - The job's order.
 * @param options.iterationsPerRun - Iterations in each run, so a run's
 * numbering starts after the previous run's last iteration whether or not
 * that iteration succeeded.
 * @param options.warmup - Each warm-up run's outcome.
 * @param options.runs - Each measured run's outcome.
 * @param options.identity - The flow's title and persona, and the platform and
 * build type, used where no run gave results.
 * @returns The merged entry.
 */
export function mergePairedRuns({
  order,
  iterationsPerRun,
  warmup,
  runs,
  identity,
}: {
  order: PairedOrder;
  iterationsPerRun: number;
  warmup: PairedRunOutcome[];
  runs: PairedRunOutcome[];
  identity: Pick<
    BenchmarkResults,
    'testTitle' | 'persona' | 'platform' | 'buildType'
  >;
}): PairedBenchmarkResults {
  const byPosition = (a: PairedRunOutcome, b: PairedRunOutcome) =>
    a.position - b.position;
  const failures: string[] = [];

  const warmupEntries = [...warmup].sort(byPosition).map((outcome) => {
    const entry: PairingRun = {
      build: outcome.build,
      position: outcome.position,
    };
    if (outcome.result?.host) {
      entry.host = outcome.result.host;
    }
    const error = runError(outcome);
    if (error) {
      entry.error = error;
      failures.push(
        `warm-up run ${outcome.position} (${outcome.build}): ${error}`,
      );
    }
    return entry;
  });

  const measured = [...runs].sort(byPosition);
  const first = measured.find((outcome) => outcome.result)?.result;
  const merged: Record<string, Record<string, IterationRecord[]>> = {};
  const append = (key: string, series: string, entries: IterationRecord[]) => {
    merged[key] ??= {};
    merged[key][series] = [...(merged[key][series] ?? []), ...entries];
  };
  const headWebVitalsRuns: PreparedWebVitalsRun[] = [];
  let lever: Record<string, unknown> | undefined;
  const leverMeasured: IterationRecord[] = [];
  const runEntries: PairingRun[] = [];

  for (const outcome of measured) {
    const run: PairingRun = {
      build: outcome.build,
      position: outcome.position,
    };
    const offset = outcome.position * iterationsPerRun;
    const error = runError(outcome);
    if (error) {
      run.error = error;
      failures.push(`run ${outcome.position} (${outcome.build}): ${error}`);
    }
    for (const [key, value] of Object.entries(outcome.result ?? {})) {
      if (
        (IDENTITY_KEYS as readonly string[]).includes(key) ||
        SUMMARY_KEYS.has(key) ||
        key === 'error'
      ) {
        continue;
      }
      if (key === 'host') {
        run.host = value as HostProvenance;
      } else if (key === 'webVitals') {
        const entries = tagIterations(
          ((value as { runs?: PreparedWebVitalsRun[] }).runs ??
            []) as (PreparedWebVitalsRun & IterationRecord)[],
          outcome,
          offset,
          false,
        );
        if (outcome.build === 'head') {
          headWebVitalsRuns.push(...entries);
        } else {
          run.webVitals = { runs: entries };
        }
      } else if (
        key === 'lever' &&
        isPlainObject(value) &&
        isIterationEntries(value.measured)
      ) {
        const { measured: entries, ...rest } = value;
        lever ??= rest;
        leverMeasured.push(...tagIterations(entries, outcome, offset));
      } else if (isPerIterationRecord(value)) {
        const target =
          key === 'values' && outcome.build === 'base' ? 'baseValues' : key;
        for (const [series, entries] of Object.entries(value)) {
          append(target, series, tagIterations(entries, outcome, offset));
        }
      } else {
        run[key] = value;
      }
    }
    runEntries.push(run);
  }

  const values = (merged.values ?? {}) as unknown as Record<
    string,
    PairedMetricSample[]
  >;
  const timers = headTimerStatistics(values);
  const webVitals =
    headWebVitalsRuns.length > 0
      ? {
          runs: headWebVitalsRuns,
          aggregated: aggregateWebVitals(
            headWebVitalsRuns.filter((run) => !run.excluded),
          ),
        }
      : undefined;
  if (webVitals) {
    for (const key of WEB_VITALS_NUMERIC_KEYS) {
      const metric = webVitals.aggregated[key];
      if (metric) {
        timers.push(metric);
      }
    }
  }

  const summary = convertTimerStatisticsToBenchmarkResults(
    timers,
    first?.testTitle ?? identity.testTitle,
    first?.persona ?? identity.persona,
    first?.benchmarkType,
    first?.platform ?? identity.platform,
    first?.buildType ?? identity.buildType,
    webVitals,
  );
  // The statistics carry the head's values without `build` and `position`;
  // the tagged ones replace them.
  const { values: _untagged, ...statistics } = summary;

  return {
    ...statistics,
    ...merged,
    ...(lever && { lever: { ...lever, measured: leverMeasured } }),
    pairing: { order, warmup: warmupEntries, runs: runEntries },
    ...(failures.length > 0 && {
      error: `paired job incomplete: ${failures.join('; ')}`,
    }),
  };
}
