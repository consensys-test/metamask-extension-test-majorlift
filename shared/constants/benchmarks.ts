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

/**
 * Filter stage that removed a per-iteration sample.
 *
 * Stages run in this order inside `calculateTimerStatistics`: sanity bounds,
 * then IQR fences, then z-score. A sample is attributed to the first stage that
 * dropped it.
 */
export const SAMPLE_EXCLUSION = {
  Sanity: 'sanity',
  Iqr: 'iqr',
  ZScore: 'zScore',
} as const;

export type SampleExclusion =
  (typeof SAMPLE_EXCLUSION)[keyof typeof SAMPLE_EXCLUSION];

/** One raw measurement together with the iteration that produced it. */
export type TimerSample = {
  /** Zero-based index of the iteration (or page load) this value came from. */
  iteration: number;
  value: number;
};

/**
 * A {@link TimerSample} carrying its trimming verdict, so a consumer can
 * recompute the distribution with or without trimming. `excludedBy` is absent
 * when the value survived every filter and is part of the reported statistics.
 */
export type TimerRun = TimerSample & {
  excludedBy?: SampleExclusion;
};

/** Per-iteration samples keyed by metric id. */
export type TimerRunsResult = Record<string, TimerRun[]>;

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
  /**
   * Every per-iteration value behind this summary, excluded ones included, so
   * the three stage-3 admission tests (dip, BIC against a two-component
   * mixture, ICC) can be run against the raw distribution.
   *
   * Optional because not every aggregation path has iteration indices to
   * attribute: web vitals keep theirs in {@link WebVitalsSummary.runs}.
   */
  runs?: TimerRun[];
  dataQuality: 'good' | 'poor' | 'unreliable';
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
  /**
   * Per-iteration samples per metric id — the timer counterpart to
   * {@link WebVitalsSummary.runs}. Named separately from `webVitals.runs`
   * because this one is keyed by metric id rather than being one flat array.
   */
  timerRuns?: TimerRunsResult;
  webVitals?: WebVitalsSummary;
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
