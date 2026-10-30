import {
  DEFAULT_BENCHMARK_BROWSER_LOADS,
  DEFAULT_BENCHMARK_PAGE_LOADS,
} from '../../../../shared/constants/benchmarks';

export const STARTUP_PRESETS = {
  STANDARD_HOME: 'startupStandardHome',
  POWER_USER_HOME: 'startupPowerUserHome',
} as const;

export const INTERACTION_PRESETS = {
  USER_ACTIONS: 'interactionUserActions',
} as const;

export const USER_JOURNEY_PRESETS = {
  ONBOARDING_IMPORT: 'userJourneyOnboardingImport',
  ONBOARDING_NEW: 'userJourneyOnboardingNew',
  ASSETS: 'userJourneyAssets',
  ACCOUNT_MANAGEMENT: 'userJourneyAccountManagement',
  TRANSACTIONS: 'userJourneyTransactions',
} as const;

export const DAPP_PAGE_LOAD_PRESETS = {
  PAGE_LOAD: 'pageLoadBenchmark',
} as const;

/** Basename of the Playwright entry spec for the dapp page-load benchmark. */
export const DAPP_PAGE_LOAD_BENCHMARK_SPEC_BASENAME =
  'dapp-page-load-benchmark.spec.ts';

/**
 * Repo-relative directory containing the dapp page-load implementation and Playwright spec.
 * Used as Playwright `testDir` for the `benchmark` project (`playwright.config.ts`).
 */
export const DAPP_PAGE_LOAD_BENCHMARK_DIR =
  'test/e2e/benchmarks/flows/dapp-page-load';

/** Repo-relative path to the Playwright spec (from repository root). */
export const DAPP_PAGE_LOAD_BENCHMARK_SPEC_PATH = `${DAPP_PAGE_LOAD_BENCHMARK_DIR}/${DAPP_PAGE_LOAD_BENCHMARK_SPEC_BASENAME}`;

/**
 * Default filename for the merged page-load benchmark JSON (Chrome + Webpack test build).
 * Keep in sync with `.github/workflows/run-benchmarks.yml` (`DAPP_BENCHMARK_JSON`).
 */
export const DAPP_PAGE_LOAD_BENCHMARK_ARTIFACT_FILENAME =
  'benchmark-chrome-webpack-pageLoadBenchmark.json';

/** Same as {@link DEFAULT_BENCHMARK_BROWSER_LOADS} in `shared/constants/benchmarks`. */
export const DEFAULT_NUM_BROWSER_LOADS = DEFAULT_BENCHMARK_BROWSER_LOADS;
/** Same as {@link DEFAULT_BENCHMARK_PAGE_LOADS} in `shared/constants/benchmarks`. */
export const DEFAULT_NUM_PAGE_LOADS = DEFAULT_BENCHMARK_PAGE_LOADS;

/** Browser loads for the POWER_USER_HOME preset (higher than default to offset warm-up exclusion). */
export const POWER_USER_NUM_BROWSER_LOADS = 15;

/**
 * Number of leading runs in each job discarded as warm-up before computing
 * stats (ADR 0072's sample preparation: "after a first run in each job that is
 * discarded as warm-up"). In the startup flows a run is a browser-load session;
 * in every other flow it is an iteration of `runBenchmarkWithIterations`.
 */
export const WARMUP_RUNS = 1;

/**
 * Number of leading page loads in each measured browser load that the startup
 * flows flag as excluded. The first page loads after unlock coincide with extra
 * network traffic and sit apart from the rest in nearly every run.
 */
export const EXCLUDED_LEADING_PAGE_LOADS = 1;

/**
 * Why a retained observation is left out of the published statistics. The
 * value stays in the artifact's `values` (or `webVitals.runs`) with this flag,
 * so a reader can recompute the statistic with or without it.
 */
export const SAMPLE_EXCLUSION = {
  /** A first run in each job, discarded as warm-up (ADR 0072). */
  WarmUp: 'warm-up',
  /** The first page load of a startup browser load. */
  FirstPageLoad: 'first-page-load',
} as const;

export type SampleExclusion =
  (typeof SAMPLE_EXCLUSION)[keyof typeof SAMPLE_EXCLUSION];

/**
 * Known-answer lever for the startup flows: a busy-wait of this many
 * milliseconds registered to run at the start of every new document, before
 * the page's own scripts. Unset, empty or 0, nothing is registered.
 */
export const KNOWN_ANSWER_STARTUP_DELAY =
  'BENCHMARK_KNOWN_ANSWER_STARTUP_DELAY_MS';

/**
 * Settle step for the startup flows: after unlock and before the first
 * measured page load, wait until the mock server's request count has not
 * changed for this many milliseconds. Unset, empty or 0, there is no wait.
 */
export const STARTUP_SETTLE_QUIET = 'BENCHMARK_STARTUP_SETTLE_QUIET_MS';

/** How often the settle step reads the request count. */
export const STARTUP_SETTLE_POLL_MS = 250;

/** The settle step gives up after this long and measures anyway. */
export const STARTUP_SETTLE_MAX_MS = 60_000;

export const ALL_METRICS = {
  uiStartup: 'UI Startup',
  load: 'navigation[0].load',
  domContentLoaded: 'navigation[0].domContentLoaded',
  firstPaint: 'paint["first-paint"]',
  loadScripts: 'Load Scripts',
  // Navigation start to the first `mm-hero-painted` mark, which the app sets
  // in the animation frame after the home view's hero node mounts. Read by the
  // startup flows (`readStartupPageSignals`), not by `collectMetrics`.
  heroPainted: 'heroPainted',
  // Requests from the start of the page load's navigation to its return,
  // which waits for `.controller-loaded` (set right after `uiStartup` ends).
  numNetworkReqs: 'numNetworkReqs',
  // Long Task / TBT metrics (benchmark-only, via `PerformanceObserver`), over
  // the long tasks that start at or before `uiStartup` ends
  // (`boundLongTasksToStartup`).
  longTaskCount: 'longTaskCount',
  longTaskTotalDuration: 'longTaskTotalDuration',
  longTaskMaxDuration: 'longTaskMaxDuration',
  tbt: 'tbt',
} as const;

export const WITH_STATE_POWER_USER = {
  withAccounts: 30,
  withConfirmedTransactions: 40,
  withContacts: 40,
  withErc20Tokens: true,
  withNetworks: true,
  withNfts: 20,
  withPreferences: true,
  withUnreadNotifications: 15,
};
