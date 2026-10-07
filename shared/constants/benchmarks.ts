/**
 * Shared benchmark configuration constants and types.
 */

export type StatisticalResult = {
  [key: string]: number;
};

export const BENCHMARK_PERSONA = {
  STANDARD: 'standard',
  POWER_USER: 'powerUser',
} as const;

export type Persona =
  (typeof BENCHMARK_PERSONA)[keyof typeof BENCHMARK_PERSONA];

export const BENCHMARK_TYPE = {
  BENCHMARK: 'benchmark',
  PERFORMANCE: 'performance',
  USER_ACTION: 'userAction',
} as const;

export type BenchmarkType =
  (typeof BENCHMARK_TYPE)[keyof typeof BENCHMARK_TYPE];

/** Web Vitals rating per web.dev thresholds */
export type WebVitalsRating = 'good' | 'needs-improvement' | 'poor';

/**
 * Core Web Vitals metrics from the web-vitals library.
 * INP requires actual user interactions to measure meaningful data.
 */
export type WebVitalsMetrics = {
  /** Interaction to Next Paint in milliseconds */
  inp: number | null;
  /** First Contentful Paint in milliseconds (always available on extension pages) */
  fcp: number | null;
  /** Largest Contentful Paint in milliseconds (null on chrome-extension:// pages) */
  lcp: number | null;
  /** Cumulative Layout Shift (unitless score) */
  cls: number | null;
  /** Rating for INP metric */
  inpRating: WebVitalsRating | null;
  /** Rating for FCP metric */
  fcpRating: WebVitalsRating | null;
  /** Rating for LCP metric */
  lcpRating: WebVitalsRating | null;
  /** Rating for CLS metric */
  clsRating: WebVitalsRating | null;
};

/** Distribution of rating buckets across benchmark runs */
export type RatingDistribution = {
  good: number;
  'needs-improvement': number;
  poor: number;
  null: number;
};

/** One retained observation: the value and the iteration that produced it. */
export type MetricSample = {
  iteration: number;
  value: number;
};

/** Per-metric retained observations, in iteration order, before filtering */
export type MetricSamples = {
  [key: string]: MetricSample[];
};

/**
 * The machine a benchmark ran on.
 *
 * A runner pool is not homogeneous — on GitHub-hosted runners the same metric
 * splits into fast and slow job modes by Azure region, 21% apart on Chrome — so
 * without this a slow box is indistinguishable from slow code, and run-to-run
 * spread conflates machine variation with the noise a gate is trying to measure.
 */
export type HostProvenance = {
  /** The `runs-on` value the job requested, passed via `BENCHMARK_RUNNER_LABEL`. */
  label?: string;
  /** `RUNNER_NAME`, where the provider sets it. */
  name?: string;
  /** Cloud region or zone. Undefined on GitHub-hosted runners; see host-provenance.ts. */
  region?: string;
  os?: string;
  arch?: string;
  cpuModel?: string;
  cpuCount?: number;
  cpuSpeedMhz?: number;
  totalMemMb?: number;
  /**
   * Cumulative CPU steal since boot, percent. These runners are VMs, so the
   * hypervisor can deschedule the guest without it appearing anywhere else.
   */
  stealPercent?: number;
  /** Fixed-work CPU probe, ms, timed in the Node process. Not the in-page probe. */
  cpuProbeMs?: number;
};

/**
 * Run-level provenance: the configuration a measurement was taken under.
 *
 * I6 of the admission gate requires every sample to carry what decided it. `host`
 * covers the MACHINE; this covers the HARNESS, which is the half that was missing.
 * The gap was not hypothetical: an I1 poll sweep on 2026-10-06 wrote three arms whose
 * only distinguishing record was the directory someone filed them in, because the poll
 * timeout the sweep exists to vary appears nowhere in the artifact.
 *
 * Deliberately NOT here: `runId` and `runAttempt`. Those are
 * `MetaMask/metamask-extension#45431`'s gaps 2 and 3 -- re-runs overwriting their own
 * S3 objects, and Sentry carrying no run identifier -- and duplicating them here would
 * put two writers on one field.
 */
export type RunProvenance = {
  /** `GITHUB_SHA`: the commit the measured build came from. */
  commit?: string;
  /** `GITHUB_JOB`: which matrix job produced this artifact. */
  jobName?: string;
  /** `BENCHMARK_ITERATIONS`, so a short run is distinguishable from a truncated one. */
  iterations?: number;
  /** `BENCHMARK_PERSONA`: the fixture state the flow ran against. */
  persona?: string;
  /**
   * The selenium poll interval in force, from `BENCHMARK_POLL_TIMEOUT_MS`.
   *
   * `null` means unset, which is not the same as absent: unset leaves selenium's own
   * default and is the condition every production run is measured under, so an arm
   * that did not set it has to be distinguishable from one measured before the knob
   * existed.
   */
  pollTimeoutMs?: number | null;
  /**
   * Which mock delays were in force, as a stable id rather than a bag of flags.
   *
   * `prod` is the shipping configuration. `zero-delay` is every mocked delay removed.
   * The two are not comparable: 88% of `swapQuoteFetch`'s production-config base is
   * fixture, so a window crossing this boundary crosses a regime.
   */
  mockRegime?: string;
  /**
   * Which injection arm, if any, was active -- the V14 tripwire or the app-side span
   * delay. Empty means a control arm, and a control has to be recorded as one.
   */
  arm?: string;
};

/** Per-metric statistics (mean, percentiles, etc.) */
export type TimerStatistics = {
  id: string;
  mean: number;
  min: number;
  max: number;
  stdDev: number;
  cv: number;
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  samples: number;
  outliers: number;
  trimmedCount?: number;
  dataQuality: 'good' | 'poor' | 'unreliable';
  /**
   * Every observation this metric was computed from, in iteration order, before
   * sanity, IQR and z-score filtering. The aggregates above are not sufficient
   * statistics for a dip test, a rank-based interval or a missingness model, so
   * the values are kept rather than re-derived.
   */
  values?: MetricSample[];
};

/** Per-metric aggregated web vitals with full statistical analysis */
export type WebVitalsAggregated = {
  inp: TimerStatistics | null;
  fcp: TimerStatistics | null;
  lcp: TimerStatistics | null;
  cls: TimerStatistics | null;
  ratings: {
    inp: RatingDistribution;
    fcp: RatingDistribution;
    lcp: RatingDistribution;
    cls: RatingDistribution;
  };
};

export type WebVitalsRun = WebVitalsMetrics & { iteration: number };

/** Full web vitals summary: per-run snapshots for Sentry spans + aggregated stats */
export type WebVitalsSummary = {
  runs: WebVitalsRun[];
  aggregated: WebVitalsAggregated;
};

export type BenchmarkResults = {
  testTitle: string;
  persona: Persona;
  benchmarkType?: BenchmarkType;
  platform?: string;
  buildType?: string;
  mean: StatisticalResult;
  min: StatisticalResult;
  max: StatisticalResult;
  stdDev: StatisticalResult;
  p75: StatisticalResult;
  p95: StatisticalResult;
  trimmedCount?: StatisticalResult;
  outliers?: StatisticalResult;
  /** Per-metric observations behind `mean` and the percentiles, before filtering */
  values?: MetricSamples;
  /** The machine this run executed on */
  host?: HostProvenance;
  webVitals?: WebVitalsSummary;
  /**
   * Set when every iteration failed. The statistics maps are then empty
   * rather than absent, so a reader cannot otherwise tell this entry from a
   * healthy one by shape alone.
   */
  error?: string;
};

export const STAT_KEY = {
  Mean: 'mean',
  StdDev: 'stdDev',
  P75: 'p75',
  P95: 'p95',
} as const;
export type StatKey = (typeof STAT_KEY)[keyof typeof STAT_KEY];

export const PERCENTILE_KEY = {
  P75: STAT_KEY.P75,
  P95: STAT_KEY.P95,
} as const;
export type PercentileKey =
  (typeof PERCENTILE_KEY)[keyof typeof PERCENTILE_KEY];

export type ComparisonKey =
  | PercentileKey
  | typeof STAT_KEY.Mean
  | typeof STAT_KEY.StdDev;

export const THRESHOLD_SEVERITY = {
  Warn: 'warn',
  Fail: 'fail',
} as const;
export type ThresholdSeverity =
  (typeof THRESHOLD_SEVERITY)[keyof typeof THRESHOLD_SEVERITY];

/**
 * Threshold limits for a single percentile.
 * Keys match ThresholdSeverity values (warn, fail).
 */
export type PercentileThreshold = Record<ThresholdSeverity, number>;

/**
 * Configuration for performance thresholds.
 * Each metric can have thresholds for P75 and/or P95 values.
 */
export type ThresholdConfig = {
  [metricName: string]: {
    /** P75 thresholds - typical user experience */
    p75?: PercentileThreshold;
    /** P95 thresholds - worst-case guardrail */
    p95?: PercentileThreshold;
    /** Multiplier for CI environments (e.g., 1.5 for slower CI machines) */
    ciMultiplier?: number;
  };
};

export type ThresholdViolation = {
  metricId: string;
  percentile: PercentileKey;
  value: number;
  threshold: number;
  severity: ThresholdSeverity;
  /**
   * Multiplicative factor applied to the base threshold because the observed
   * CV for this metric fell in the adaptive-widening band (25% ≤ CV ≤ 50%).
   * Undefined when no CV adjustment was applied. The `threshold` field above
   * already carries the fully-adjusted (CI × CV) effective value; this factor
   * lets downstream consumers recover the pre-widening threshold if needed.
   */
  cvAdjustment?: number;
};

/**
 * Aggregated historical baseline for a single metric,
 * with values for each stat key (mean, p75, p95).
 */
export type HistoricalBaselineMetrics = Omit<
  Record<StatKey, number>,
  'stdDev'
> & {
  stdDev?: number;
};

export type RelativeThresholds = {
  regressionPercent: number;
  warnPercent: number;
};

/**
 * Uniform relative thresholds applied to all metrics.
 * These are informational only (do not affect pass/fail).
 * Per-metric overrides can be set via relativeThresholds in ThresholdConfig.
 */
export const DEFAULT_RELATIVE_THRESHOLDS: RelativeThresholds = {
  regressionPercent: 0.1,
  warnPercent: 0.05,
};

export const BENCHMARK_PLATFORMS = {
  CHROME: 'chrome',
  FIREFOX: 'firefox',
} as const;

export const BENCHMARK_BUILD_TYPES = {
  WEBPACK: 'webpack',
} as const;

export const ALL_BENCHMARK_COMBOS: readonly string[] = Object.values(
  BENCHMARK_PLATFORMS,
).flatMap((platform) =>
  Object.values(BENCHMARK_BUILD_TYPES).map(
    (buildType) => `${platform}-${buildType}`,
  ),
);

export const DEFAULT_BENCHMARK_ITERATIONS = 5;

export const DEFAULT_BENCHMARK_BROWSER_LOADS = 10;
export const DEFAULT_BENCHMARK_PAGE_LOADS = 10;

export const DEFAULT_BENCHMARK_LOAD_MATRIX_SAMPLE_COUNT =
  DEFAULT_BENCHMARK_BROWSER_LOADS * DEFAULT_BENCHMARK_PAGE_LOADS;

export type BenchmarkAnnounceSamples = {
  sampleQuantity: number;
};

export type BenchmarkAnnounceSection = {
  title: string;
  announceSamples: BenchmarkAnnounceSamples;
};

export const BENCHMARK_ANNOUNCE_SECTIONS = {
  interaction: {
    title: 'Interaction Benchmarks',
    announceSamples: {
      sampleQuantity: DEFAULT_BENCHMARK_ITERATIONS,
    },
  },
  startup: {
    title: 'Startup Benchmarks',
    announceSamples: {
      sampleQuantity: DEFAULT_BENCHMARK_LOAD_MATRIX_SAMPLE_COUNT,
    },
  },
  userJourney: {
    title: 'User Journey Benchmarks',
    announceSamples: {
      sampleQuantity: DEFAULT_BENCHMARK_ITERATIONS,
    },
  },
  dappPageLoad: {
    title: 'Dapp Page Load Benchmarks',
    announceSamples: {
      sampleQuantity: DEFAULT_BENCHMARK_LOAD_MATRIX_SAMPLE_COUNT,
    },
  },
} as const satisfies Record<string, BenchmarkAnnounceSection>;
