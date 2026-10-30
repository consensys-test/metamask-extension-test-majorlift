import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
  type BenchmarkResults,
  type TimerStatistics,
} from '../../../../../shared/constants/benchmarks';
import { calculateTimerStatistics } from '../../utils/statistics';
import { convertTimerStatisticsToBenchmarkResults } from '../../utils/runner';
import { WARMUP_RUNS } from '../../utils/constants';
import type { DappPageLoadSample, DappPageLoadStats } from '../../utils/types';

const DAPP_PAGE_LOAD_BENCHMARK_KEY = 'dappPageLoad';

const NUMERIC_METRIC_KEYS = [
  'pageLoadTime',
  'domContentLoaded',
  'firstPaint',
  'firstContentfulPaint',
  'largestContentfulPaint',
] as const;

/**
 * The run number of the first page load whose values enter the statistics.
 *
 * The first {@link WARMUP_RUNS} browser loads of a job are discarded as
 * warm-up, as the startup flows discard theirs. A browser load here does not
 * relaunch the browser: the persistent context, and with it the HTTP cache,
 * lives for the whole job, and only cookies and permissions are cleared
 * between browser loads. So only the job's first page loads start from an
 * empty cache.
 *
 * @param browserLoads - Browser loads in the job.
 * @param pageLoads - Page loads per browser load.
 * @returns The first measured run; run numbers below it are warm-up.
 */
export function getFirstMeasuredRun(
  browserLoads: number,
  pageLoads: number,
): number {
  if (browserLoads <= WARMUP_RUNS) {
    throw new Error(
      `browserLoads (${browserLoads}) must be greater than WARMUP_RUNS (${WARMUP_RUNS})`,
    );
  }
  return WARMUP_RUNS * pageLoads;
}

export type DappPageLoadAggregationOptions = {
  /**
   * Samples whose `run` is below this are warm-up: they enter neither the
   * statistics nor `values`. The rest keep their run number as their
   * iteration. Default 0, so every sample counts.
   */
  firstMeasuredRun?: number;
};

/**
 * Groups raw samples by page label, then builds {@link DappPageLoadStats} per page
 * (one {@link TimerStatistics} per numeric web-vital key).
 *
 * Each timer keeps every measured page load's value, untrimmed, under its
 * run number, so the artifact's statistics can be re-derived from it.
 *
 * @param samples - Raw measurements from {@link PageLoadBenchmark}
 * @param options - Which samples are warm-up.
 * @param options.firstMeasuredRun - The first run that is not warm-up.
 */
export function aggregateDappPageLoadStatistics(
  samples: DappPageLoadSample[],
  { firstMeasuredRun = 0 }: DappPageLoadAggregationOptions = {},
): DappPageLoadStats[] {
  const resultsByPage = samples
    .filter((sample) => sample.run >= firstMeasuredRun)
    .reduce(
      (acc, result) => {
        if (!acc[result.page]) {
          acc[result.page] = [];
        }
        acc[result.page].push(result);
        return acc;
      },
      {} as Record<string, DappPageLoadSample[]>,
    );

  const summaries: DappPageLoadStats[] = [];

  for (const [page, pageResults] of Object.entries(resultsByPage)) {
    const timers: TimerStatistics[] = [];
    for (const key of NUMERIC_METRIC_KEYS) {
      const measured = pageResults.filter(
        (r) => typeof r.metrics[key] === 'number',
      );
      if (measured.length > 0) {
        timers.push(
          calculateTimerStatistics(
            key,
            measured.map((r) => r.metrics[key]),
            { iterations: measured.map((r) => r.run) },
          ),
        );
      }
    }

    summaries.push({ page, timers });
  }

  return summaries;
}

/**
 * Converts aggregated dapp page-load stats to the JSON shape used by CI and Sentry.
 *
 * Currently only a single page is benchmarked. An assertion guards against
 * silent data loss if multiple pages are ever added without updating the
 * output key structure.
 *
 * @param statsByPage - Per-page aggregates from {@link aggregateDappPageLoadStatistics}
 */
export function dappPageLoadStatsToBenchmarkResults(
  statsByPage: DappPageLoadStats[],
): Record<string, BenchmarkResults> {
  if (statsByPage.length !== 1) {
    throw new Error(
      `Expected exactly 1 page in dapp page-load benchmark, got ${statsByPage.length}. ` +
        'If multiple pages are needed, update the output key to include the page label.',
    );
  }

  return {
    [DAPP_PAGE_LOAD_BENCHMARK_KEY]: convertTimerStatisticsToBenchmarkResults(
      statsByPage[0].timers,
      DAPP_PAGE_LOAD_BENCHMARK_KEY,
      BENCHMARK_PERSONA.POWER_USER,
      BENCHMARK_TYPE.PERFORMANCE,
    ),
  };
}
