import get from 'lodash/get';
import { retry } from '../../../../development/lib/retry';
import type {
  BenchmarkResults,
  BenchmarkType,
  Persona,
  StatisticalResult,
  ThresholdConfig,
  MetricSample,
  MetricSamples,
  TimerStatistics,
  WebVitalsAggregated,
  WebVitalsMetrics,
  WebVitalsRun,
  WebVitalsSummary,
} from '../../../../shared/constants/benchmarks';
import { BENCHMARK_PERSONA } from '../../../../shared/constants/benchmarks';
import type { Driver } from '../../webdriver/driver';
import { getKnownAnswerDelayMs } from '../mocks/known-answer';
import { captureHostProvenance } from './host-provenance';
import {
  ALL_METRICS,
  DEFAULT_NUM_BROWSER_LOADS,
  DEFAULT_NUM_PAGE_LOADS,
  EXCLUDED_LEADING_PAGE_LOADS,
  KNOWN_ANSWER_STARTUP_DELAY,
  SAMPLE_EXCLUSION,
  STARTUP_SETTLE_MAX_MS,
  STARTUP_SETTLE_POLL_MS,
  STARTUP_SETTLE_QUIET,
  WARMUP_RUNS,
} from './constants';
import type { SampleExclusion } from './constants';
import {
  aggregateWebVitals,
  calcMaxResult,
  calcMeanResult,
  calcMinResult,
  calcPResult,
  calcStdDevResult,
  calculateTimerStatistics,
  checkExclusionRate,
  detectOutliersIQR,
  MAX_EXCLUSION_RATE,
  MAX_TOTAL_DURATION_MS,
  validateThresholds,
  WEB_VITALS_NUMERIC_KEYS,
} from './statistics';
import type { PreparedMetricSample } from './statistics';
import type {
  BenchmarkFunction,
  BenchmarkRunResult,
  BenchmarkSummary,
  MeasurePageResult,
  Metrics,
  NetworkReport,
  UserActionMeasurement,
} from './types';
import { performanceTracker } from './performance-tracker';

/** Which mechanism supplied a web vital's value (recorded by `cwv-read.js`). */
export type WebVitalSource =
  | 'paint-entry'
  | 'harness-observer'
  | 'state-hooks'
  | 'hero-mark';

/**
 * The source of each web vital, beside its value in a run. `null` where the
 * vital has no value.
 */
export type WebVitalsSources = {
  inpSource?: WebVitalSource | null;
  fcpSource?: WebVitalSource | null;
  lcpSource?: WebVitalSource | null;
  clsSource?: WebVitalSource | null;
};

/** A web vitals run, flagged when sample preparation leaves it out. */
export type PreparedWebVitalsRun = WebVitalsRun &
  WebVitalsSources & {
    excluded?: SampleExclusion;
  };

/** The console errors and uncaught exceptions one browser load produced. */
export type BrowserErrorRecord = {
  /**
   * Whether the session listened for them at all. Only chrome attaches the
   * listeners (CDP), so on firefox the two lists are empty by construction.
   */
  captured: boolean;
  consoleErrors: string[];
  exceptions: string[];
};

/** The outcome of the startup settle step (see `waitForNetworkQuiet`). */
export type SettleRecord = {
  quietMs: number;
  waitedMs: number;
  settled: boolean;
};

/** What a startup flow records about one browser load beyond its metrics. */
export type BrowserLoadRecord = {
  /** 0-based; the first `WARMUP_RUNS` browser loads are the discarded warm-up. */
  browserLoad: number;
  browserErrors?: BrowserErrorRecord;
  settle?: SettleRecord;
};

/** One browser load's result from a startup flow. */
export type StartupMeasurePageResult = MeasurePageResult & {
  browserLoad?: Omit<BrowserLoadRecord, 'browserLoad'>;
};

/** Startup benchmark results, with what each browser load recorded. */
export type PageLoadBenchmarkResults = BenchmarkResults & {
  browserLoadRecords?: BrowserLoadRecord[];
};

/** Per-page-load metrics from a startup flow, with the series it adds. */
export type StartupMetrics = Metrics & { heroPainted?: number };

/**
 * The sample-preparation flag for an iteration of `runBenchmarkWithIterations`:
 * the first `WARMUP_RUNS` iterations of each job are discarded as warm-up.
 *
 * @param iteration - 0-based iteration index within the job.
 */
function exclusionForIteration(iteration: number): SampleExclusion | undefined {
  return iteration < WARMUP_RUNS ? SAMPLE_EXCLUSION.WarmUp : undefined;
}

/**
 * Promote web vitals aggregated stats into a TimerStatistics array.
 * This allows web vitals to flow through the same threshold validation
 * pipeline as traditional timers.
 *
 * @param aggregated - Aggregated web vitals from {@link aggregateWebVitals}
 */
function extractWebVitalsAsTimerStats(
  aggregated: WebVitalsAggregated,
): TimerStatistics[] {
  const stats: TimerStatistics[] = [];
  for (const key of WEB_VITALS_NUMERIC_KEYS) {
    const metric = aggregated[key];
    if (metric) {
      stats.push(metric);
    }
  }
  return stats;
}

/**
 * Run a benchmark function with retries
 * Wraps the shared retry utility to handle benchmark functions that return
 * { success: false } instead of throwing errors.
 *
 * @param benchmarkFn - The benchmark function to execute
 * @param retries - Number of retries if the benchmark fails
 */
async function runWithRetries(
  benchmarkFn: BenchmarkFunction,
  retries: number,
): Promise<BenchmarkRunResult> {
  let lastResult: BenchmarkRunResult = {
    timers: [],
    success: false,
    error: 'Unknown error',
  };

  try {
    return await retry({ retries, delay: 1000 }, async () => {
      performanceTracker.reset();

      const result = await benchmarkFn();
      lastResult = result;

      if (!result.success) {
        throw new Error(result.error ?? 'Benchmark failed');
      }
      return result;
    });
  } catch {
    return lastResult;
  }
}

type CdpInnerDriver = {
  sendDevToolsCommand?: (
    command: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
};

const invokeWindowGc = () => {
  const windowWithGc = window as Window & { gc?: () => void };
  if (typeof windowWithGc.gc === 'function') {
    windowWithGc.gc();
    return true;
  }
  return false;
};

/**
 * Force a GC cycle outside the measurement window so heap debt is less likely
 * to spill into the next page-load iteration.
 *
 * Prefers `window.gc()` when Chrome is launched with `--expose-gc`, and falls
 * back to ChromeDriver CDP heap collection when available.
 *
 * @param driver - MetaMask Selenium driver wrapper for the current benchmark page
 */
export async function collectGarbageBetweenIterations(
  driver: Driver,
): Promise<void> {
  try {
    const didRunWindowGc = await driver.executeScript(invokeWindowGc);

    if (didRunWindowGc) {
      return;
    }
  } catch {
    // Fall back to CDP heap collection below.
  }

  const innerDriver = driver.driver as CdpInnerDriver | undefined;
  if (!innerDriver?.sendDevToolsCommand) {
    return;
  }

  try {
    await innerDriver.sendDevToolsCommand('HeapProfiler.collectGarbage');
  } catch {
    // Best-effort normalization only.
  }
}

export async function runBenchmarkWithIterations(
  name: string,
  benchmarkFn: BenchmarkFunction,
  iterations: number,
  retries: number,
  thresholdConfig: ThresholdConfig,
): Promise<BenchmarkSummary> {
  if (iterations <= WARMUP_RUNS) {
    throw new Error(
      `iterations (${iterations}) must be greater than WARMUP_RUNS (${WARMUP_RUNS}): the first ${WARMUP_RUNS} of each job is discarded as warm-up`,
    );
  }

  const allResults: BenchmarkRunResult[] = [];
  let successfulRuns = 0;
  let failedRuns = 0;

  for (let i = 0; i < iterations; i++) {
    const result = await runWithRetries(benchmarkFn, retries);
    allResults.push(result);

    if (result.success) {
      successfulRuns += 1;
      // Generate report after each successful run (like Mocha's afterEach)
      const timerCount = performanceTracker.getTimerCount();
      if (timerCount > 0) {
        performanceTracker.generateReport(`${name} - iteration ${i + 1}`, name);
      }
    } else {
      failedRuns += 1;
    }
  }

  // Aggregate timer results and collect per-run web vitals. Every observation
  // is kept; the warm-up iteration is flagged and left out of the statistics
  // (ADR 0072's sample preparation), not dropped.
  const timerMap = new Map<string, MetricSample[]>();
  const zeroAllowedTimers = new Set<string>();
  const webVitalsRuns: PreparedWebVitalsRun[] = [];

  for (let idx = 0; idx < allResults.length; idx++) {
    const result = allResults[idx];
    if (result.success) {
      for (const timer of result.timers) {
        if (!timerMap.has(timer.id)) {
          timerMap.set(timer.id, []);
        }
        const timerSamples = timerMap.get(timer.id);
        if (timerSamples) {
          timerSamples.push({ iteration: idx, value: timer.value });
        }
        if (timer.unit) {
          zeroAllowedTimers.add(timer.id);
        }
      }

      if (result.webVitals) {
        const excluded = exclusionForIteration(idx);
        webVitalsRuns.push({
          ...result.webVitals,
          iteration: idx,
          ...(excluded && { excluded }),
        });
      }
    }
  }

  const timerStats: TimerStatistics[] = [];
  let excludedDueToQuality = 0;

  for (const [timerId, samples] of timerMap) {
    const durations = samples.map((sample) => sample.value);
    const exclusions = samples.map((sample) =>
      exclusionForIteration(sample.iteration),
    );
    const stats = calculateTimerStatistics(timerId, durations, {
      iterations: samples.map((sample) => sample.iteration),
      exclusions,
      ...(zeroAllowedTimers.has(timerId) ? { minDurationMs: 0 } : {}),
    });
    timerStats.push(stats);

    if (stats.dataQuality === 'unreliable') {
      excludedDueToQuality += 1;
    }

    // Check if too many samples were excluded for this timer. The warm-up is
    // sample preparation, not a quality exclusion, so the rate is taken over
    // the observations that were eligible for the statistics.
    const eligible = exclusions.filter(
      (exclusion) => exclusion === undefined,
    ).length;
    const exclusionCheck = checkExclusionRate(
      eligible,
      eligible - stats.samples,
      MAX_EXCLUSION_RATE,
    );

    // A timer observed only in the warm-up has no statistic at all; its zeros
    // must not read as a measurement.
    if (
      (exclusionCheck.passed === false || eligible === 0) &&
      stats.dataQuality !== 'unreliable'
    ) {
      // Mark as unreliable if too many exclusions (only if not already unreliable)
      stats.dataQuality = 'unreliable';
      excludedDueToQuality += 1;
    }
  }

  // Compute per-run total durations and derive total statistics from them
  // (min/max/percentiles are not additive across timers from different runs)
  const perRunTotals: MetricSample[] = [];
  for (let idx = 0; idx < allResults.length; idx++) {
    const result = allResults[idx];
    if (result.success && result.timers.length > 0) {
      // Exclude long task diagnostic metrics (tagged with unit) from the
      // per-run total. They represent blocking time already captured within
      // the timed steps and would double-count if summed.
      const runTotal = result.timers
        .filter((t) => !t.unit)
        .reduce((acc, t) => acc + t.value, 0);
      perRunTotals.push({ iteration: idx, value: runTotal });
    }
  }
  if (perRunTotals.length > 0) {
    const totalStats = calculateTimerStatistics(
      'total',
      perRunTotals.map((sample) => sample.value),
      {
        iterations: perRunTotals.map((sample) => sample.iteration),
        exclusions: perRunTotals.map((sample) =>
          exclusionForIteration(sample.iteration),
        ),
        maxDurationMs: MAX_TOTAL_DURATION_MS,
      },
    );
    timerStats.push(totalStats);
  }

  // Check overall run exclusion rate
  const overallExclusionCheck = checkExclusionRate(
    iterations,
    failedRuns,
    MAX_EXCLUSION_RATE,
  );

  // Aggregate web vitals if any runs reported them
  let webVitalsSummary: WebVitalsSummary | undefined;
  if (webVitalsRuns.length > 0) {
    const aggregated = aggregateWebVitals(
      webVitalsRuns.filter((run) => !run.excluded),
    );
    webVitalsSummary = { runs: webVitalsRuns, aggregated };

    // Promote web vitals into timerStats so they flow through threshold validation
    timerStats.push(...extractWebVitalsAsTimerStats(aggregated));
  }

  const thresholdResult = validateThresholds(timerStats, thresholdConfig);
  // Extract benchmarkType from the first result (same across all iterations)
  const benchmarkType = allResults.find((r) => r.benchmarkType)?.benchmarkType;

  return {
    name,
    iterations,
    successfulRuns,
    failedRuns,
    timers: timerStats,
    timestamp: new Date().toISOString(),
    excludedDueToQuality,
    exclusionRatePassed: overallExclusionCheck.passed,
    exclusionRate: overallExclusionCheck.rate,
    thresholdViolations: thresholdResult?.violations ?? [],
    thresholdsPassed: thresholdResult?.passed ?? true,
    ...(webVitalsSummary && { webVitals: webVitalsSummary }),
    // Carry the reasons only when nothing succeeded. Each failed iteration
    // already records why it failed; that was discarded here, so a benchmark
    // whose every iteration threw produced empty statistics and no trace of
    // the cause.
    ...(successfulRuns === 0 &&
      allResults.length > 0 && {
        iterationErrors: [
          ...new Set(
            allResults
              .map((result) => result.error)
              .filter((message): message is string => Boolean(message)),
          ),
        ],
      }),
    benchmarkType,
  };
}

/**
 * Maps aggregated timer statistics to `BenchmarkResults` (shared with send-to-sentry and CI JSON).
 * Used by Selenium benchmarks and Playwright dapp page-load benchmarks.
 *
 * @param timers - One {@link TimerStatistics} per metric id (e.g. timer name or web vital key)
 * @param testTitle - Benchmark label written to JSON
 * @param persona - Wallet persona for this run
 * @param benchmarkType - Optional benchmark category
 * @param platform - Optional platform label
 * @param buildType - Optional build label
 * @param webVitals - Optional aggregated web vitals (from {@link BenchmarkSummary.webVitals})
 */
export function convertTimerStatisticsToBenchmarkResults(
  timers: TimerStatistics[],
  testTitle: string,
  persona: Persona = BENCHMARK_PERSONA.STANDARD,
  benchmarkType?: BenchmarkType,
  platform?: string,
  buildType?: string,
  webVitals?: WebVitalsSummary,
): BenchmarkResults {
  const mean: StatisticalResult = {};
  const min: StatisticalResult = {};
  const max: StatisticalResult = {};
  const stdDev: StatisticalResult = {};
  const p75: StatisticalResult = {};
  const p95: StatisticalResult = {};
  const trimmedCount: StatisticalResult = {};
  const outliers: StatisticalResult = {};
  const values: MetricSamples = {};

  // timers already includes promoted web vitals from runBenchmarkWithIterations
  for (const timer of timers) {
    mean[timer.id] = timer.mean;
    min[timer.id] = timer.min;
    max[timer.id] = timer.max;
    stdDev[timer.id] = timer.stdDev;
    p75[timer.id] = timer.p75;
    p95[timer.id] = timer.p95;
    if (timer.trimmedCount !== undefined) {
      trimmedCount[timer.id] = timer.trimmedCount;
    }
    outliers[timer.id] = timer.outliers;
    if (timer.values !== undefined) {
      values[timer.id] = timer.values;
    }
  }

  const hasTrimmedCounts = Object.keys(trimmedCount).length > 0;
  const hasOutliers = Object.keys(outliers).length > 0;
  const hasValues = Object.keys(values).length > 0;
  const host = captureHostProvenance();

  return {
    testTitle,
    persona,
    benchmarkType,
    platform,
    buildType,
    mean,
    min,
    max,
    stdDev,
    p75,
    p95,
    ...(hasTrimmedCounts && { trimmedCount }),
    ...(hasOutliers && { outliers }),
    ...(hasValues && { values }),
    host,
    ...(webVitals && { webVitals }),
  };
}

/**
 * Convert BenchmarkSummary (from runBenchmarkWithIterations) to BenchmarkResults format
 * for consistent output with send-to-sentry.ts
 *
 * @param summary
 * @param testTitle
 * @param persona
 * @param benchmarkType
 * @param platform
 * @param buildType
 */
export function convertSummaryToResults(
  summary: BenchmarkSummary,
  testTitle: string,
  persona: Persona = BENCHMARK_PERSONA.STANDARD,
  benchmarkType?: BenchmarkType,
  platform?: string,
  buildType?: string,
): BenchmarkResults {
  const results = convertTimerStatisticsToBenchmarkResults(
    summary.timers,
    testTitle,
    persona,
    benchmarkType,
    platform,
    buildType,
    summary.webVitals,
  );

  if (summary.successfulRuns > 0) {
    return results;
  }

  // Every iteration failed. Without this the entry carries empty statistics
  // maps and nothing else, which is shape-identical to a healthy benchmark
  // and is why a totally failed flow can read as merely quiet.
  const reasons = summary.iterationErrors?.length
    ? `: ${summary.iterationErrors.join('; ')}`
    : '';
  return {
    ...results,
    error: `every iteration failed (0 of ${summary.iterations} succeeded)${reasons}`,
  };
}

/**
 * Run the dApp page-load benchmark and aggregate results.
 *
 * Uses IQR-only outlier trimming (`trimmedCount`). Z-score is intentionally
 * excluded for two reasons:
 *
 * 1. Serial correlation: page loads run serially within each browser session
 * (shared JIT cache, extension state). A slow startup elevates all `pageLoads`
 * measurements in a session as a correlated cluster. Z-score assumes i.i.d.
 * samples and would flag the cluster as outliers even when the elevation has a
 * real underlying cause. IQR is rank-based and distribution-free, making it
 * robust to correlated samples.
 *
 * 2. Multimodal distributions: `longTask*`, `tbt`, and `numNetworkReqs` are
 * zero or near-zero most runs with occasional real spikes. Z-score would flag
 * those spikes as noise, removing genuine signal.
 *
 * `calculateTimerStatistics` (iteration-based benchmarks) applies both IQR and
 * z-score because each run is an independent browser session.
 *
 * Sample preparation: the first `WARMUP_RUNS` browser loads are discarded, and
 * in every later browser load the first `EXCLUDED_LEADING_PAGE_LOADS` page
 * loads are kept in `values` (and `webVitals.runs`) flagged `first-page-load`
 * and left out of the statistics.
 *
 * @param measurePageFn - Function that drives one browser session and returns metrics
 * @param options - Benchmark configuration
 * @param options.browserLoads - Number of full browser sessions to run
 * @param options.pageLoads - Number of page loads per browser session
 * @param options.retries - Number of retries per browser session on failure
 * @param options.platform - Optional platform label written to results
 * @param options.buildType - Optional build label written to results
 */
export async function runPageLoadBenchmark(
  measurePageFn: (
    pageName: string,
    pageLoads: number,
  ) => Promise<StartupMeasurePageResult>,
  options: {
    browserLoads?: number;
    pageLoads?: number;
    retries?: number;
    platform?: string;
    buildType?: string;
  },
): Promise<PageLoadBenchmarkResults> {
  const {
    browserLoads = DEFAULT_NUM_BROWSER_LOADS,
    pageLoads = DEFAULT_NUM_PAGE_LOADS,
    retries = 0,
    platform,
    buildType,
  } = options;

  if (browserLoads <= WARMUP_RUNS) {
    throw new Error(
      `browserLoads (${browserLoads}) must be greater than WARMUP_RUNS (${WARMUP_RUNS})`,
    );
  }
  if (pageLoads <= EXCLUDED_LEADING_PAGE_LOADS) {
    throw new Error(
      `pageLoads (${pageLoads}) must be greater than EXCLUDED_LEADING_PAGE_LOADS (${EXCLUDED_LEADING_PAGE_LOADS})`,
    );
  }

  const pageName = 'home';
  let runResults: Metrics[] = [];
  let allWebVitalsRuns: WebVitalsRun[] = [];
  const browserLoadRecords: BrowserLoadRecord[] = [];
  let testTitle = '';
  let resultPersona: Persona = BENCHMARK_PERSONA.STANDARD;

  for (let i = 0; i < browserLoads; i += 1) {
    console.log('Starting browser load', i + 1, 'of', browserLoads);
    const { metrics, title, persona, webVitalsRuns, browserLoad } =
      await retryBrowserLoad(() => measurePageFn(pageName, pageLoads), {
        index: i,
        total: browserLoads,
        retries,
      });
    runResults = runResults.concat(metrics);
    if (webVitalsRuns) {
      const indexed = webVitalsRuns.map((wv: WebVitalsMetrics, j: number) => ({
        ...wv,
        iteration: i * pageLoads + j,
      }));
      allWebVitalsRuns = allWebVitalsRuns.concat(indexed);
    }
    if (browserLoad) {
      browserLoadRecords.push({ browserLoad: i, ...browserLoad });
    }
    testTitle = title;
    resultPersona = persona;
  }

  // Discard the first WARMUP_RUNS browser-load sessions before computing stats.
  // Each session contributes exactly pageLoads metric objects to runResults.
  const warmupSize = WARMUP_RUNS * pageLoads;
  const measuredResults = runResults.slice(warmupSize);
  // The page load's position within its browser load sets its flag. Iteration
  // numbers run on across browser loads, so the position is the remainder.
  const exclusionForPageLoad = (
    iteration: number,
  ): SampleExclusion | undefined =>
    iteration % pageLoads < EXCLUDED_LEADING_PAGE_LOADS
      ? SAMPLE_EXCLUSION.FirstPageLoad
      : undefined;
  // Web vitals entries are sparse (collection can fail silently), so filter by
  // iteration index rather than slicing by position to avoid off-by-N errors.
  // `inp` is dropped here: startup has no user interaction, so what it timed
  // was the collector's own probe click and its 16 ms handler.
  const measuredWebVitalsRuns: PreparedWebVitalsRun[] = allWebVitalsRuns
    .filter((wv) => wv.iteration >= warmupSize)
    .map((wv) => {
      const excluded = exclusionForPageLoad(wv.iteration);
      return {
        ...wv,
        inp: null,
        inpRating: null,
        inpSource: null,
        ...(excluded && { excluded }),
      };
    });

  if (measuredResults.some((result) => result.navigation.length > 1)) {
    throw new Error(`Multiple navigations not supported`);
  }
  const firstNonNavigate = measuredResults.find(
    (result) => result.navigation[0].type !== 'navigate',
  );
  if (firstNonNavigate !== undefined) {
    throw new Error(
      `Navigation type ${firstNonNavigate.navigation[0].type} not supported`,
    );
  }

  const result: Record<string, number[]> = {};
  const trimmedCounts: StatisticalResult = {};
  const values: MetricSamples = {};
  for (const [key, tracePath] of Object.entries(ALL_METRICS)) {
    const rawSamples = measuredResults.map((m) => get(m, tracePath) as number);
    // A metric this browser never reports (firefox has no `first-paint` entry
    // and no long-task observer) is not emitted. Emitting it wrote a key with no
    // statistics and `values` entries that carry no value.
    if (rawSamples.every((value) => value === undefined)) {
      continue;
    }
    // `result[key]` is filtered and sorted, so neither the discarded samples nor
    // the order survives it. The iteration numbering matches `WebVitalsRun`'s:
    // warm-up sessions are dropped, and the remainder keep their original index.
    const prepared: PreparedMetricSample[] = rawSamples.map((value, index) => {
      const iteration = warmupSize + index;
      const excluded = exclusionForPageLoad(iteration);
      return { iteration, value, ...(excluded && { excluded }) };
    });
    const included = prepared
      .filter((sample) => !sample.excluded && Number.isFinite(sample.value))
      .map((sample) => sample.value);
    const { filtered, outlierCount } = detectOutliersIQR(included);
    result[key] = [...filtered].sort((a, b) => a - b);
    trimmedCounts[key] = outlierCount;
    values[key] = prepared;
  }

  let webVitals: WebVitalsSummary | undefined;
  if (measuredWebVitalsRuns.length > 0) {
    webVitals = {
      runs: measuredWebVitalsRuns,
      aggregated: aggregateWebVitals(
        measuredWebVitalsRuns.filter((run) => !run.excluded),
      ),
    };
  }

  const mean = calcMeanResult(result);
  const min = calcMinResult(result);
  const max = calcMaxResult(result);
  const stdDevResult = calcStdDevResult(result);
  const p75 = calcPResult(result, 75);
  const p95 = calcPResult(result, 95);

  // Promote web vitals aggregated stats into the top-level maps
  if (webVitals?.aggregated) {
    for (const wv of extractWebVitalsAsTimerStats(webVitals.aggregated)) {
      mean[wv.id] = wv.mean;
      min[wv.id] = wv.min;
      max[wv.id] = wv.max;
      stdDevResult[wv.id] = wv.stdDev;
      p75[wv.id] = wv.p75;
      p95[wv.id] = wv.p95;
    }
  }

  return {
    testTitle,
    persona: resultPersona,
    platform,
    buildType,
    mean,
    min,
    max,
    stdDev: stdDevResult,
    p75,
    p95,
    trimmedCount: trimmedCounts,
    outliers: { ...trimmedCounts },
    values,
    host: captureHostProvenance(),
    ...(webVitals && { webVitals }),
    ...(browserLoadRecords.length > 0 && { browserLoadRecords }),
  };
}

/**
 * Run one browser load with retries. When every attempt fails, the error names
 * the browser load and carries each attempt's reason, as
 * `runBenchmarkWithIterations` does; `retry()` alone throws the fixed string
 * "Retry limit reached" and leaves the cause only in the console.
 *
 * @param measure - Drives the browser load.
 * @param options - Where this browser load sits, and how often to retry it.
 * @param options.index - 0-based index of the browser load.
 * @param options.total - How many browser loads the benchmark runs.
 * @param options.retries - Retries after the first attempt.
 */
export async function retryBrowserLoad<TResult>(
  measure: () => Promise<TResult>,
  { index, total, retries }: { index: number; total: number; retries: number },
): Promise<TResult> {
  const reasons: string[] = [];
  try {
    return await retry({ retries }, async () => {
      try {
        return await measure();
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  } catch {
    const distinct = [...new Set(reasons)];
    throw new Error(
      `browser load ${index + 1} of ${total} failed on all ${retries + 1} attempts: ${
        distinct.length > 0 ? distinct.join('; ') : 'no error message'
      }`,
    );
  }
}

/**
 * The startup known-answer delay, from {@link KNOWN_ANSWER_STARTUP_DELAY}.
 *
 * @returns Milliseconds, 0 when the variable is unset or empty.
 */
export function readStartupDelayMs(): number {
  return getKnownAnswerDelayMs(KNOWN_ANSWER_STARTUP_DELAY);
}

/**
 * The startup settle window, from {@link STARTUP_SETTLE_QUIET}.
 *
 * @returns Milliseconds, 0 (no settle step) when the variable is unset or empty.
 */
export function readStartupSettleQuietMs(): number {
  return getKnownAnswerDelayMs(STARTUP_SETTLE_QUIET);
}

/**
 * The page script that busy-waits `delayMs` milliseconds, in the top-level
 * document only. The automation protocol runs it at the start of every new
 * document, child frames included, and each frame's wait would add another
 * `delayMs` to the measured page.
 *
 * @param delayMs - How long to block the page's main thread.
 */
export function documentStartDelaySource(delayMs: number): string {
  return `(() => { if (window !== window.top) { return; } const end = performance.now() + ${delayMs}; while (performance.now() < end) { /* known-answer startup delay */ } })();`;
}

type DocumentStartInnerDriver = CdpInnerDriver & {
  getCapabilities?: () => Promise<{ get: (key: string) => unknown }>;
  getBidi?: () => Promise<{
    send: (command: {
      method: string;
      params: Record<string, unknown>;
    }) => Promise<unknown>;
  }>;
};

/**
 * Known-answer lever for the startup intervals: register a busy-wait of
 * `delayMs` to run at the start of every document this session loads from now
 * on, before the page's own scripts. If it runs where intended it lands on the
 * critical path of every interval timed from navigation start (`loadScripts`,
 * `domContentLoaded`, `load`, `uiStartup`, `heroPainted`). It changes no app
 * source: the script is injected by the browser's automation protocol.
 *
 * Chrome uses CDP `Page.addScriptToEvaluateOnNewDocument`; a session with a
 * WebDriver BiDi connection uses `script.addPreloadScript`. With neither, it
 * throws rather than let a lever run measure nothing.
 *
 * @param driver - The benchmark's driver.
 * @param delayMs - Milliseconds; 0 registers nothing.
 */
export async function installDocumentStartDelay(
  driver: Driver,
  delayMs: number,
): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  const source = documentStartDelaySource(delayMs);
  const innerDriver = driver.driver as DocumentStartInnerDriver | undefined;

  if (innerDriver?.sendDevToolsCommand) {
    await innerDriver.sendDevToolsCommand(
      'Page.addScriptToEvaluateOnNewDocument',
      { source },
    );
    return;
  }

  const capabilities = await innerDriver?.getCapabilities?.();
  if (
    innerDriver?.getBidi &&
    typeof capabilities?.get('webSocketUrl') === 'string'
  ) {
    const bidi = await innerDriver.getBidi();
    await bidi.send({
      method: 'script.addPreloadScript',
      params: { functionDeclaration: `() => { ${source} }` },
    });
    return;
  }

  throw new Error(
    `${KNOWN_ANSWER_STARTUP_DELAY} is ${delayMs}, but this session has neither CDP nor a WebDriver BiDi connection, so the delay cannot be registered`,
  );
}

/**
 * Settle step: wait until the mock server's request count has not changed for
 * `quietMs`, so the first measured page load does not start while the requests
 * set off by unlock are still running. Gives up after `maxMs` and says so.
 *
 * @param getNetworkReport - The mock server's request counter.
 * @param quietMs - How long the count must hold still.
 * @param options - Polling, for tests.
 * @param options.pollMs - How often to read the count.
 * @param options.maxMs - When to stop waiting.
 * @param options.sleep - Waits the given milliseconds.
 * @param options.now - The current time in milliseconds.
 */
export async function waitForNetworkQuiet(
  getNetworkReport: () => NetworkReport,
  quietMs: number,
  {
    pollMs = STARTUP_SETTLE_POLL_MS,
    maxMs = STARTUP_SETTLE_MAX_MS,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
  }: {
    pollMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<SettleRecord> {
  const start = now();
  let lastCount = getNetworkReport().numNetworkReqs;
  let lastChange = start;
  while (now() - lastChange < quietMs) {
    if (now() - start >= maxMs) {
      return { quietMs, waitedMs: now() - start, settled: false };
    }
    await sleep(pollMs);
    const count = getNetworkReport().numNetworkReqs;
    if (count !== lastCount) {
      lastCount = count;
      lastChange = now();
    }
  }
  return { quietMs, waitedMs: now() - start, settled: true };
}

/** The app's long-task record, as `stateHooks.getLongTaskMetrics` returns it. */
export type LongTaskRecord = {
  observed: boolean;
  count: number;
  tasks: { startTime: number; duration: number }[];
};

/** What the startup flows read from the page after each page load. */
export type StartupPageSignals = {
  /** `startTime` of the first `mm-hero-painted` mark; null if none was set. */
  heroPainted: number | null;
  /** Null when the page exposes no long-task hook. */
  longTasks: LongTaskRecord | null;
};

/**
 * Runs in the page. Kept free of closures: it is serialized and sent there.
 */
const readStartupPageSignalsInPage = (): StartupPageSignals => {
  const marks = performance.getEntriesByName('mm-hero-painted', 'mark');
  const hooks = (
    window as unknown as {
      stateHooks?: { getLongTaskMetrics?: () => LongTaskRecord };
    }
  ).stateHooks;
  const longTaskData = hooks?.getLongTaskMetrics?.();
  return {
    heroPainted: marks.length > 0 ? marks[0].startTime : null,
    longTasks: longTaskData
      ? {
          observed: longTaskData.observed === true,
          count: longTaskData.count,
          tasks: longTaskData.tasks.map((task) => ({
            startTime: task.startTime,
            duration: task.duration,
          })),
        }
      : null,
  };
};

/**
 * Read the home view's hero mark and the app's long-task record from the page.
 *
 * @param driver - The benchmark's driver, on the extension page.
 */
export async function readStartupPageSignals(
  driver: Driver,
): Promise<StartupPageSignals> {
  return (await driver.executeScript(
    readStartupPageSignalsInPage,
  )) as StartupPageSignals;
}

/** A task longer than this blocks input; the app uses the same bound. */
const LONG_TASK_BLOCKING_MS = 50;

/**
 * The long-task series over the tasks that start at or before `uiStartupEnd`,
 * so the window ends at startup rather than at whenever metrics are collected.
 *
 * @param longTasks - The app's long-task record.
 * @param uiStartupEnd - When `uiStartup` ended, in the page's
 * `performance.now()` frame. The trace starts at `performance.timeOrigin`, so
 * its duration is that time.
 * @returns The four series, or undefined when the observer never attached, the
 * end is unknown, or the app's 50-task store may have dropped a task in the
 * window.
 */
export function boundLongTasksToStartup(
  longTasks: LongTaskRecord | null,
  uiStartupEnd: number | undefined,
):
  | Required<
      Pick<
        Metrics,
        | 'longTaskCount'
        | 'longTaskTotalDuration'
        | 'longTaskMaxDuration'
        | 'tbt'
      >
    >
  | undefined {
  if (
    !longTasks?.observed ||
    uiStartupEnd === undefined ||
    !Number.isFinite(uiStartupEnd)
  ) {
    return undefined;
  }
  const inWindow = longTasks.tasks.filter(
    (task) => task.startTime <= uiStartupEnd,
  );
  // The app keeps only the first tasks it observes. When it dropped some and
  // every stored one is inside the window, a dropped one may be inside too.
  const dropped = longTasks.count > longTasks.tasks.length;
  if (dropped && inWindow.length === longTasks.tasks.length) {
    return undefined;
  }
  const durations = inWindow.map((task) => task.duration);
  return {
    longTaskCount: inWindow.length,
    longTaskTotalDuration: durations.reduce((sum, d) => sum + d, 0),
    longTaskMaxDuration: durations.length > 0 ? Math.max(...durations) : 0,
    tbt: durations.reduce(
      (sum, d) => sum + Math.max(0, d - LONG_TASK_BLOCKING_MS),
      0,
    ),
  };
}

/**
 * Fold what `readStartupPageSignals` read into one page load's metrics. The
 * long-task series `collectMetrics` returns run to the moment of collection,
 * after the flow's sleep and interactions; they are replaced by the window that
 * ends at `uiStartup`, or removed when that window cannot be computed.
 *
 * @param metrics - From `driver.collectMetrics()`.
 * @param signals - From `readStartupPageSignals`.
 */
export function applyStartupPageSignals(
  metrics: Metrics,
  signals: StartupPageSignals,
): StartupMetrics {
  const {
    longTaskCount: _count,
    longTaskTotalDuration: _total,
    longTaskMaxDuration: _max,
    tbt: _tbt,
    ...rest
  } = metrics;
  const bounded = boundLongTasksToStartup(
    signals.longTasks,
    metrics['UI Startup'],
  );
  return {
    ...rest,
    ...bounded,
    ...(signals.heroPainted !== null && { heroPainted: signals.heroPainted }),
  };
}

export async function runUserActionBenchmark(
  measureFn: () => Promise<UserActionMeasurement>,
  benchmarkType?: BenchmarkType,
): Promise<BenchmarkRunResult> {
  try {
    const { timers, webVitals } = await measureFn();
    return { timers, webVitals, success: true, benchmarkType };
  } catch (error) {
    return {
      timers: [],
      success: false,
      error: error instanceof Error ? error.message : String(error),
      benchmarkType,
    };
  }
}
