import { readFileSync } from 'fs';
import path from 'path';
import { runInNewContext } from 'vm';
import type {
  TimerStatistics,
  WebVitalsMetrics,
} from '../../../../shared/constants/benchmarks';
import type { Driver } from '../../webdriver/driver';
import {
  applyStartupPageSignals,
  boundLongTasksToStartup,
  collectGarbageBetweenIterations,
  convertSummaryToResults,
  convertTimerStatisticsToBenchmarkResults,
  documentStartDelaySource,
  installDocumentStartDelay,
  installStartUiSyncBlock,
  isStartupPostHeroLongTasksOn,
  readStartupLeverMarks,
  readStartupPageSignals,
  readStartupSyncBlockMs,
  retryBrowserLoad,
  runBenchmarkWithIterations,
  runPageLoadBenchmark,
  selectPostHeroLongTasks,
  startUiSyncBlockSource,
  waitForNetworkQuiet,
} from './runner';
import type {
  LongTaskRecord,
  PreparedWebVitalsRun,
  StartupMeasurePageResult,
  StartupPageSignals,
} from './runner';
import type {
  BenchmarkRunResult,
  BenchmarkSummary,
  InPageCpuProbeReading,
  Metrics,
} from './types';

jest.mock('./host-provenance', () => ({
  captureHostProvenance: () => ({ label: 'test' }),
}));

function createTimerStats(
  id: string,
  overrides: Partial<TimerStatistics> = {},
): TimerStatistics {
  return {
    id,
    mean: 100,
    min: 90,
    max: 110,
    stdDev: 5,
    cv: 5,
    p50: 100,
    p75: 105,
    p95: 109,
    p99: 110,
    samples: 3,
    outliers: 0,
    dataQuality: 'good',
    ...overrides,
  };
}

function createMockDriver(
  overrides: {
    executeScript?: jest.Mock;
    innerSendDevToolsCommand?: jest.Mock | null;
  } = {},
): Driver {
  const innerDriver: Record<string, unknown> = {};

  if (overrides.innerSendDevToolsCommand !== null) {
    innerDriver.sendDevToolsCommand =
      overrides.innerSendDevToolsCommand ??
      jest.fn().mockResolvedValue(undefined);
  }

  return {
    executeScript: overrides.executeScript ?? jest.fn().mockResolvedValue(true),
    driver:
      overrides.innerSendDevToolsCommand === null ? undefined : innerDriver,
  } as unknown as Driver;
}

describe('collectGarbageBetweenIterations', () => {
  it('uses window.gc when exposed on the page', async () => {
    const executeScript = jest.fn().mockResolvedValue(true);
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendDevToolsCommand).not.toHaveBeenCalled();
  });

  it('falls back to HeapProfiler.collectGarbage when window.gc is unavailable', async () => {
    const executeScript = jest.fn().mockResolvedValue(false);
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(sendDevToolsCommand).toHaveBeenCalledTimes(1);
    expect(sendDevToolsCommand).toHaveBeenCalledWith(
      'HeapProfiler.collectGarbage',
    );
  });

  it('falls back to CDP when window.gc execution throws', async () => {
    const executeScript = jest
      .fn()
      .mockRejectedValue(new Error('script failed'));
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(sendDevToolsCommand).toHaveBeenCalledWith(
      'HeapProfiler.collectGarbage',
    );
  });

  it('does nothing when neither window.gc nor CDP are available', async () => {
    const executeScript = jest.fn().mockResolvedValue(false);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: null,
    });

    await expect(
      collectGarbageBetweenIterations(driver),
    ).resolves.toBeUndefined();
  });
});

describe('convertTimerStatisticsToBenchmarkResults', () => {
  it("carries each timer's retained values into the artifact", () => {
    const results = convertTimerStatisticsToBenchmarkResults(
      [
        createTimerStats('uiStartup', {
          values: [
            { iteration: 0, value: 90 },
            { iteration: 2, value: 110 },
          ],
        }),
      ],
      'measurePageStandard',
    );

    expect(results.values).toStrictEqual({
      uiStartup: [
        { iteration: 0, value: 90 },
        { iteration: 2, value: 110 },
      ],
    });
  });

  it('omits values entirely when no timer retained any', () => {
    const results = convertTimerStatisticsToBenchmarkResults(
      [createTimerStats('uiStartup')],
      'measurePageStandard',
    );

    expect(results).not.toHaveProperty('values');
    expect(results.mean.uiStartup).toBe(100);
  });

  it('keeps the metrics that did retain values when another did not', () => {
    const results = convertTimerStatisticsToBenchmarkResults(
      [
        createTimerStats('uiStartup', {
          values: [{ iteration: 0, value: 90 }],
        }),
        createTimerStats('load'),
      ],
      'measurePageStandard',
    );

    expect(Object.keys(results.values ?? {})).toStrictEqual(['uiStartup']);
  });
});

const NULL_VITALS: WebVitalsMetrics = {
  inp: null,
  fcp: null,
  lcp: null,
  cls: null,
  inpRating: null,
  fcpRating: null,
  lcpRating: null,
  clsRating: null,
};

/**
 * A benchmark function whose nth call is iteration n.
 *
 * @param stepValues - The `step` timer's value per iteration.
 * @param extra - Further timers and web vitals per iteration.
 */
function iterationsOf(
  stepValues: number[],
  extra: (iteration: number) => Partial<BenchmarkRunResult> = () => ({}),
) {
  let calls = 0;
  return jest.fn(async (): Promise<BenchmarkRunResult> => {
    const iteration = calls;
    calls += 1;
    const { timers = [], ...rest } = extra(iteration);
    return {
      success: true,
      timers: [{ id: 'step', value: stepValues[iteration] }, ...timers],
      ...rest,
    };
  });
}

describe('runBenchmarkWithIterations', () => {
  it('keeps iteration 0 in values, flagged as warm-up, and out of the statistics', async () => {
    const summary = await runBenchmarkWithIterations(
      'flow',
      iterationsOf([500, 100, 102, 104, 106]),
      5,
      0,
      {},
    );
    const step = summary.timers.find((timer) => timer.id === 'step');

    expect(step?.values).toStrictEqual([
      { iteration: 0, value: 500, excluded: 'warm-up' },
      { iteration: 1, value: 100 },
      { iteration: 2, value: 102 },
      { iteration: 3, value: 104 },
      { iteration: 4, value: 106 },
    ]);
    expect(step?.samples).toBe(4);
    expect(step?.mean).toBe(103);
    expect(step?.max).toBe(106);
    expect(step?.dataQuality).toBe('good');
  });

  it('leaves the warm-up out of the per-run total as well', async () => {
    const summary = await runBenchmarkWithIterations(
      'flow',
      iterationsOf([500, 100, 102, 104, 106]),
      5,
      0,
      {},
    );
    const total = summary.timers.find((timer) => timer.id === 'total');

    expect(total?.mean).toBe(103);
    expect(total?.values?.[0]).toStrictEqual({
      iteration: 0,
      value: 500,
      excluded: 'warm-up',
    });
  });

  it('keeps the warm-up web vitals run, flagged, and aggregates the rest', async () => {
    const fcp = [900, 100, 102, 104, 106];
    const summary = await runBenchmarkWithIterations(
      'flow',
      iterationsOf([500, 100, 102, 104, 106], (iteration) => ({
        webVitals: { ...NULL_VITALS, fcp: fcp[iteration] },
      })),
      5,
      0,
      {},
    );

    const runs = summary.webVitals?.runs as PreparedWebVitalsRun[];
    expect(runs).toHaveLength(5);
    expect(runs[0]).toMatchObject({
      iteration: 0,
      fcp: 900,
      excluded: 'warm-up',
    });
    expect(runs[1].excluded).toBeUndefined();
    expect(summary.webVitals?.aggregated.fcp?.mean).toBe(103);
    expect(summary.webVitals?.aggregated.fcp?.samples).toBe(4);
  });

  it('marks a timer observed only in the warm-up unreliable, not zero and good', async () => {
    const summary = await runBenchmarkWithIterations(
      'flow',
      iterationsOf([500, 100, 102, 104, 106], (iteration) =>
        iteration === 0 ? { timers: [{ id: 'onlyFirst', value: 50 }] } : {},
      ),
      5,
      0,
      {},
    );
    const onlyFirst = summary.timers.find((timer) => timer.id === 'onlyFirst');

    expect(onlyFirst?.samples).toBe(0);
    expect(onlyFirst?.dataQuality).toBe('unreliable');
  });

  it('rejects a run too short to keep anything after the warm-up', async () => {
    const benchmarkFn = iterationsOf([100]);
    await expect(
      runBenchmarkWithIterations('flow', benchmarkFn, 1, 0, {}),
    ).rejects.toThrow('iterations (1) must be greater than WARMUP_RUNS (1)');
    expect(benchmarkFn).not.toHaveBeenCalled();
  });

  describe('in-page CPU probe', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      // `retry` logs each failed iteration.
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('reads before iteration 0 and after each iteration, outside them, and keeps the readings', async () => {
      const order: string[] = [];
      let calls = 0;
      const benchmarkFn = jest.fn(async (): Promise<BenchmarkRunResult> => {
        order.push(`iteration ${calls}`);
        calls += 1;
        return { success: true, timers: [{ id: 'step', value: 100 }] };
      });
      let reads = 0;
      const read = jest.fn(async (): Promise<InPageCpuProbeReading> => {
        order.push('probe');
        reads += 1;
        return { ms: 60 + reads };
      });

      const summary = await runBenchmarkWithIterations(
        'flow',
        benchmarkFn,
        3,
        0,
        {},
        read,
      );

      expect(order).toStrictEqual([
        'probe',
        'iteration 0',
        'probe',
        'iteration 1',
        'probe',
        'iteration 2',
        'probe',
      ]);
      expect(summary.inPageCpuProbe).toStrictEqual({
        beforeIteration0: { ms: 61 },
        afterIteration: [{ ms: 62 }, { ms: 63 }, { ms: 64 }],
      });
      expect(console.log).toHaveBeenCalledWith(
        '[benchmark] in-page CPU probe before iteration 0: 61.0 ms',
      );
      expect(console.log).toHaveBeenCalledWith(
        '[benchmark] in-page CPU probe after iteration 2: 64.0 ms',
      );
      // The readings are not timers, so no statistic is made of them.
      expect(summary.timers.map((timer) => timer.id)).toStrictEqual([
        'step',
        'total',
      ]);
    });

    it('reads after a failed iteration too, and keeps a reader that throws as an error', async () => {
      const benchmarkFn = jest.fn(
        async (): Promise<BenchmarkRunResult> => ({
          success: false,
          timers: [],
          error: 'failed',
        }),
      );
      const read = jest
        .fn<Promise<InPageCpuProbeReading>, []>()
        .mockResolvedValueOnce({ ms: 61 })
        .mockRejectedValueOnce(new Error('session failed'))
        .mockResolvedValueOnce({ error: 'the page returned null' });

      const summary = await runBenchmarkWithIterations(
        'flow',
        benchmarkFn,
        2,
        0,
        {},
        read,
      );

      expect(summary.inPageCpuProbe).toStrictEqual({
        beforeIteration0: { ms: 61 },
        afterIteration: [
          { error: 'session failed' },
          { error: 'the page returned null' },
        ],
      });
      expect(console.log).toHaveBeenCalledWith(
        '[benchmark] in-page CPU probe after iteration 0 absent: session failed',
      );
    });

    it('runs nothing between iterations without a reader', async () => {
      const summary = await runBenchmarkWithIterations(
        'flow',
        iterationsOf([500, 100]),
        2,
        0,
        {},
      );

      expect(summary).not.toHaveProperty('inPageCpuProbe');
      expect(console.log).not.toHaveBeenCalled();
    });
  });
});

describe('convertSummaryToResults', () => {
  /**
   * A summary of one flow's iterations.
   *
   * @param overrides - Fields to replace.
   * @returns The summary.
   */
  function summaryOf(
    overrides: Partial<BenchmarkSummary> = {},
  ): BenchmarkSummary {
    return {
      name: 'flow',
      iterations: 2,
      successfulRuns: 2,
      failedRuns: 0,
      timers: [createTimerStats('step')],
      timestamp: '2026-10-31T00:00:00.000Z',
      excludedDueToQuality: 0,
      exclusionRatePassed: true,
      exclusionRate: 0,
      thresholdViolations: [],
      thresholdsPassed: true,
      ...overrides,
    };
  }

  const inPageCpuProbe = {
    beforeIteration0: { ms: 61 },
    afterIteration: [{ ms: 62 }, { error: 'session failed' }],
  };

  it('puts the in-page CPU probe readings beside the host fields', () => {
    const results = convertSummaryToResults(
      summaryOf({ inPageCpuProbe }),
      'flow',
    );

    expect(results.host).toStrictEqual({ label: 'test', inPageCpuProbe });
  });

  it('keeps them when every iteration failed', () => {
    const results = convertSummaryToResults(
      summaryOf({ successfulRuns: 0, failedRuns: 2, inPageCpuProbe }),
      'flow',
    );

    expect(results.error).toMatch(/^every iteration failed/u);
    expect(results.host).toStrictEqual({ label: 'test', inPageCpuProbe });
  });

  it('leaves the host fields as they are when the probe did not run', () => {
    const results = convertSummaryToResults(summaryOf(), 'flow');

    expect(results.host).toStrictEqual({ label: 'test' });
  });
});

/**
 * One page load's metrics as `collectMetrics` returns them, without
 * `first-paint` and without long tasks, as on firefox.
 *
 * @param uiStartup - The value for every interval timed from navigation start.
 */
function pageLoadMetrics(uiStartup: number): Metrics {
  return {
    navigation: [
      {
        load: uiStartup,
        domContentLoaded: uiStartup,
        domInteractive: 20,
        type: 'navigate',
      },
    ],
    paint: {},
    'UI Startup': uiStartup,
    'Background Connect': 30,
    'First Render': 2,
    'Initial Actions': 2,
    'Load Scripts': uiStartup,
    'Setup Store': 18,
    numNetworkReqs: 40,
  };
}

/**
 * A `measurePageFn` whose nth call is browser load n.
 *
 * @param uiStartupByBrowserLoad - Per browser load, `uiStartup` per page load.
 * @param extra - Further result fields per browser load.
 */
function browserLoadsOf(
  uiStartupByBrowserLoad: number[][],
  extra: (
    browserLoad: number,
  ) => Partial<StartupMeasurePageResult> = () => ({}),
) {
  let calls = 0;
  return jest.fn(async (): Promise<StartupMeasurePageResult> => {
    const browserLoad = calls;
    calls += 1;
    return {
      metrics: uiStartupByBrowserLoad[browserLoad].map(pageLoadMetrics),
      title: 'measurePageStandard',
      persona: 'standard',
      ...extra(browserLoad),
    };
  });
}

describe('runPageLoadBenchmark', () => {
  // Browser load 0 is the discarded warm-up. In the other two, page load 0 is
  // slow and must be flagged; the statistics are those of [100, 102, 104, 106].
  const UI_STARTUP = [
    [999, 999, 999],
    [500, 100, 102],
    [500, 104, 106],
  ];

  it('flags the first page load of each browser load and leaves it out of the statistics', async () => {
    const results = await runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
      browserLoads: 3,
      pageLoads: 3,
    });

    expect(results.values?.uiStartup).toStrictEqual([
      { iteration: 3, value: 500, excluded: 'first-page-load' },
      { iteration: 4, value: 100 },
      { iteration: 5, value: 102 },
      { iteration: 6, value: 500, excluded: 'first-page-load' },
      { iteration: 7, value: 104 },
      { iteration: 8, value: 106 },
    ]);
    expect(results.mean.uiStartup).toBe(103);
    expect(results.max.uiStartup).toBe(106);
  });

  it('does not emit a metric the browser never reported', async () => {
    const results = await runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
      browserLoads: 3,
      pageLoads: 3,
    });

    for (const absent of [
      'firstPaint',
      'longTaskCount',
      'tbt',
      'heroPainted',
    ]) {
      expect(results.mean).not.toHaveProperty(absent);
      expect(results.values).not.toHaveProperty(absent);
      expect(results.trimmedCount).not.toHaveProperty(absent);
    }
    expect(results.mean).toHaveProperty('numNetworkReqs', 40);
  });

  it('no longer emits the short nested intervals', async () => {
    const results = await runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
      browserLoads: 3,
      pageLoads: 3,
    });

    for (const dropped of [
      'firstReactRender',
      'initialActions',
      'setupStore',
      'backgroundConnect',
      'domInteractive',
    ]) {
      expect(results.mean).not.toHaveProperty(dropped);
    }
  });

  it('drops inp, flags first page loads and carries each vital source', async () => {
    const results = await runPageLoadBenchmark(
      browserLoadsOf(UI_STARTUP, (browserLoad) => ({
        webVitalsRuns: [0, 1, 2].map((pageLoad) => ({
          ...NULL_VITALS,
          inp: 16,
          inpRating: 'good' as const,
          fcp: pageLoad === 0 ? 900 : 100 + browserLoad + pageLoad,
          fcpSource: 'state-hooks',
        })),
      })),
      { browserLoads: 3, pageLoads: 3 },
    );

    const runs = results.webVitals?.runs as PreparedWebVitalsRun[];
    expect(runs.map((run) => run.iteration)).toStrictEqual([3, 4, 5, 6, 7, 8]);
    expect(runs.map((run) => run.excluded)).toStrictEqual([
      'first-page-load',
      undefined,
      undefined,
      'first-page-load',
      undefined,
      undefined,
    ]);
    expect(
      runs.every((run) => run.inp === null && run.inpSource === null),
    ).toBe(true);
    expect(runs[1].fcpSource).toBe('state-hooks');
    expect(results.mean).not.toHaveProperty('inp');
    expect(results.webVitals?.aggregated.inp).toBeNull();
    // fcp of page loads 1 and 2 in browser loads 1 and 2: 102, 103, 103, 104.
    expect(results.mean.fcp).toBe(103);
  });

  it('records what each browser load captured', async () => {
    const results = await runPageLoadBenchmark(
      browserLoadsOf(UI_STARTUP, (browserLoad) => ({
        browserLoad: {
          browserErrors: {
            captured: true,
            consoleErrors: browserLoad === 2 ? ['TypeError: mutations'] : [],
            exceptions: [],
          },
        },
      })),
      { browserLoads: 3, pageLoads: 3 },
    );

    expect(results.browserLoadRecords).toHaveLength(3);
    expect(results.browserLoadRecords?.[2]).toStrictEqual({
      browserLoad: 2,
      browserErrors: {
        captured: true,
        consoleErrors: ['TypeError: mutations'],
        exceptions: [],
      },
    });
  });

  it('names the browser load and its error when every attempt fails', async () => {
    // `retry()` logs each failed attempt; the assertion is on the thrown error.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const measurePageFn = jest
      .fn()
      .mockRejectedValue(
        new Error('Waiting for element to be located .controller-loaded'),
      );

    await expect(
      runPageLoadBenchmark(measurePageFn, {
        browserLoads: 2,
        pageLoads: 3,
        retries: 1,
      }),
    ).rejects.toThrow(
      'browser load 1 of 2 failed on all 2 attempts: Waiting for element to be located .controller-loaded',
    );
    expect(measurePageFn).toHaveBeenCalledTimes(2);
  });

  it('rejects one page load per browser load, which would leave nothing to measure', async () => {
    await expect(
      runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
        browserLoads: 3,
        pageLoads: 1,
      }),
    ).rejects.toThrow(
      'pageLoads (1) must be greater than EXCLUDED_LEADING_PAGE_LOADS (1)',
    );
  });
});

describe('retryBrowserLoad', () => {
  beforeEach(() => {
    // `retry()` logs each failed attempt; the assertions are on the outcome.
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('returns the first attempt that succeeds', async () => {
    const measure = jest
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockResolvedValueOnce('ok');

    await expect(
      retryBrowserLoad(measure, { index: 0, total: 1, retries: 2 }),
    ).resolves.toBe('ok');
  });

  it('lists each distinct reason once', async () => {
    const measure = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('console error'));

    await expect(
      retryBrowserLoad(measure, { index: 4, total: 10, retries: 2 }),
    ).rejects.toThrow(
      'browser load 5 of 10 failed on all 3 attempts: timeout; console error',
    );
  });
});

describe('installDocumentStartDelay', () => {
  it('registers nothing when the delay is 0', async () => {
    const sendDevToolsCommand = jest.fn();
    const driver = { driver: { sendDevToolsCommand } } as unknown as Driver;

    await installDocumentStartDelay(driver, 0);

    expect(sendDevToolsCommand).not.toHaveBeenCalled();
  });

  it('registers the busy-wait through CDP where the session has it', async () => {
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = { driver: { sendDevToolsCommand } } as unknown as Driver;

    await installDocumentStartDelay(driver, 300);

    expect(sendDevToolsCommand).toHaveBeenCalledWith(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: documentStartDelaySource(300) },
    );
  });

  it('registers a BiDi preload script where the session has BiDi', async () => {
    const send = jest.fn().mockResolvedValue({ result: { script: 'id' } });
    const driver = {
      driver: {
        getCapabilities: jest.fn().mockResolvedValue({
          get: (key: string) =>
            key === 'webSocketUrl' ? 'ws://localhost:1234/session' : undefined,
        }),
        getBidi: jest.fn().mockResolvedValue({ send }),
      },
    } as unknown as Driver;

    await installDocumentStartDelay(driver, 300);

    expect(send).toHaveBeenCalledWith({
      method: 'script.addPreloadScript',
      params: {
        functionDeclaration: `() => { ${documentStartDelaySource(300)} }`,
      },
    });
  });

  it('throws rather than run a lever that cannot be registered', async () => {
    const driver = {
      driver: {
        getCapabilities: jest.fn().mockResolvedValue({ get: () => undefined }),
        getBidi: jest.fn(),
      },
    } as unknown as Driver;

    await expect(installDocumentStartDelay(driver, 300)).rejects.toThrow(
      'BENCHMARK_KNOWN_ANSWER_STARTUP_DELAY_MS is 300, but this session has neither CDP nor a WebDriver BiDi connection',
    );
  });

  it('builds a script that blocks for the delay in the top-level document', () => {
    const topWindow: Record<string, unknown> = {};
    topWindow.top = topWindow;
    const start = performance.now();
    runInNewContext(documentStartDelaySource(30), {
      performance,
      window: topWindow,
    });
    expect(performance.now() - start).toBeGreaterThanOrEqual(30);
  });

  it('does not block in a child frame', () => {
    const topWindow = {};
    const frameWindow = { top: topWindow };
    const start = performance.now();
    runInNewContext(documentStartDelaySource(200), {
      performance,
      window: frameWindow,
    });
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('waitForNetworkQuiet', () => {
  it('returns once the request count has held still for the window', async () => {
    let time = 0;
    const settle = await waitForNetworkQuiet(
      // Rises by one per 250 ms poll until 1000 ms, then stops.
      () => ({ numNetworkReqs: Math.min(time, 1000) / 250 }),
      500,
      {
        pollMs: 250,
        maxMs: 10_000,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );

    expect(settle).toStrictEqual({
      quietMs: 500,
      waitedMs: 1500,
      settled: true,
    });
  });

  it('gives up after the cap and says it did not settle', async () => {
    let time = 0;
    const settle = await waitForNetworkQuiet(
      () => ({ numNetworkReqs: time }),
      500,
      {
        pollMs: 250,
        maxMs: 2000,
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
      },
    );

    expect(settle).toStrictEqual({
      quietMs: 500,
      waitedMs: 2000,
      settled: false,
    });
  });
});

describe('boundLongTasksToStartup', () => {
  const tasks: LongTaskRecord['tasks'] = [
    { startTime: 100, duration: 80 },
    { startTime: 500, duration: 60 },
    { startTime: 1500, duration: 200 },
  ];

  it('counts only the tasks that start by the end of uiStartup', () => {
    expect(
      boundLongTasksToStartup({ observed: true, count: 3, tasks }, 1000),
    ).toStrictEqual({
      longTaskCount: 2,
      longTaskTotalDuration: 140,
      longTaskMaxDuration: 80,
      tbt: 40,
    });
  });

  it('reports zeros when the observer attached and nothing blocked', () => {
    expect(
      boundLongTasksToStartup(
        { observed: true, count: 1, tasks: [tasks[2]] },
        1000,
      ),
    ).toStrictEqual({
      longTaskCount: 0,
      longTaskTotalDuration: 0,
      longTaskMaxDuration: 0,
      tbt: 0,
    });
  });

  it('reports nothing when the observer never attached', () => {
    expect(
      boundLongTasksToStartup({ observed: false, count: 0, tasks: [] }, 1000),
    ).toBeUndefined();
  });

  it('reports nothing when the end of uiStartup is unknown', () => {
    expect(
      boundLongTasksToStartup({ observed: true, count: 3, tasks }, undefined),
    ).toBeUndefined();
  });

  it('reports nothing when the app dropped tasks that may fall in the window', () => {
    // 60 observed, 50 stored, every stored one inside the window.
    const stored = Array.from({ length: 50 }, (_, i) => ({
      startTime: i,
      duration: 60,
    }));
    expect(
      boundLongTasksToStartup(
        { observed: true, count: 60, tasks: stored },
        1000,
      ),
    ).toBeUndefined();
  });

  it('still counts when the dropped tasks all came after the window', () => {
    const stored = [
      ...Array.from({ length: 49 }, (_, i) => ({ startTime: i, duration: 60 })),
      { startTime: 2000, duration: 60 },
    ];
    expect(
      boundLongTasksToStartup(
        { observed: true, count: 60, tasks: stored },
        1000,
      )?.longTaskCount,
    ).toBe(49);
  });
});

describe('applyStartupPageSignals', () => {
  const collected = {
    ...pageLoadMetrics(1000),
    // As `collectMetrics` returns them: everything up to collection, which
    // includes the flow's interactions after startup.
    longTaskCount: 9,
    longTaskTotalDuration: 900,
    longTaskMaxDuration: 300,
    tbt: 450,
  };

  it('replaces the long-task series with the window ending at uiStartup and adds heroPainted', () => {
    const metrics = applyStartupPageSignals(collected, {
      heroPainted: 850,
      longTasks: {
        observed: true,
        count: 2,
        tasks: [
          { startTime: 100, duration: 80 },
          { startTime: 1200, duration: 300 },
        ],
      },
    });

    expect(metrics).toMatchObject({
      heroPainted: 850,
      longTaskCount: 1,
      longTaskTotalDuration: 80,
      longTaskMaxDuration: 80,
      tbt: 30,
    });
    expect(metrics['UI Startup']).toBe(1000);
  });

  it('removes the long-task series when no window can be computed, and adds no hero time when the page set none', () => {
    const metrics = applyStartupPageSignals(collected, {
      heroPainted: null,
      longTasks: null,
    });

    expect(metrics).not.toHaveProperty('longTaskCount');
    expect(metrics).not.toHaveProperty('tbt');
    expect(metrics).not.toHaveProperty('heroPainted');
  });
});

describe('readStartupPageSignals', () => {
  const pageWindow = window as unknown as { stateHooks?: unknown };
  const originalGetEntriesByName = performance.getEntriesByName;

  afterEach(() => {
    delete pageWindow.stateHooks;
    performance.getEntriesByName = originalGetEntriesByName;
  });

  it('reads the first hero mark and the long-task record in the page', async () => {
    performance.getEntriesByName = jest
      .fn()
      .mockReturnValue([{ startTime: 850 }, { startTime: 1900 }]);
    pageWindow.stateHooks = {
      getLongTaskMetrics: () => ({
        observed: true,
        count: 1,
        totalDuration: 70,
        tasks: [{ name: 'self', startTime: 10, duration: 70 }],
      }),
    };
    const driver = {
      executeScript: jest.fn((script: () => unknown) => script()),
    } as unknown as Driver;

    await expect(readStartupPageSignals(driver)).resolves.toStrictEqual({
      heroPainted: 850,
      longTasks: {
        observed: true,
        count: 1,
        tasks: [{ startTime: 10, duration: 70 }],
      },
    });
    expect(performance.getEntriesByName).toHaveBeenCalledWith(
      'mm-hero-painted',
      'mark',
    );
  });

  it('reads null for each signal the page does not have', async () => {
    performance.getEntriesByName = jest.fn().mockReturnValue([]);
    const driver = {
      executeScript: jest.fn((script: () => unknown) => script()),
    } as unknown as Driver;

    await expect(readStartupPageSignals(driver)).resolves.toStrictEqual({
      heroPainted: null,
      longTasks: null,
    });
  });
});

describe('cwv-read.js', () => {
  const READ_SCRIPT = readFileSync(
    path.join(__dirname, 'cwv-read.js'),
    'utf-8',
  );

  /**
   * Run the read script against a fake page.
   *
   * @param page - The page's state.
   * @param page.cwv - What the setup script collected.
   * @param page.stateHooks - The app's web-vitals hooks, if any.
   * @param page.heroMarks - `mm-hero-painted` marks.
   */
  function read({
    cwv = {},
    stateHooks,
    heroMarks = [],
  }: {
    cwv?: Record<string, unknown>;
    stateHooks?: Record<string, unknown>;
    heroMarks?: { startTime: number }[];
  }) {
    const fakeWindow = {
      // The global the setup script writes and the read script reads.
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __cwv: {
        event: [],
        lcp: [],
        cls: [],
        observers: [],
        clsSupported: false,
        eventObserverSupported: false,
        probeReceived: false,
        fcp: null,
        ...cwv,
      },
      stateHooks,
    };
    // The script is a function body (it ends in `return result`), as
    // `executeScript` runs it.
    return runInNewContext(`(function () {\n${READ_SCRIPT}\n})()`, {
      window: fakeWindow,
      performance: { getEntriesByName: () => heroMarks },
      PerformanceObserver: { supportedEntryTypes: [] },
    });
  }

  it("records the harness's own sources", () => {
    const result = read({
      cwv: {
        fcp: 300,
        clsSupported: true,
        lcp: [{ startTime: 650 }],
        event: [{ duration: 16 }],
      },
    });

    expect(result).toMatchObject({
      fcp: 300,
      fcpSource: 'paint-entry',
      lcp: 650,
      lcpSource: 'harness-observer',
      cls: 0,
      clsSource: 'harness-observer',
      inp: 16,
      inpSource: 'harness-observer',
    });
  });

  it("records the app's web-vitals library where it supplied the value", () => {
    const result = read({
      cwv: { fcp: 300, clsSupported: true },
      stateHooks: {
        getWebVitalsMetrics: () => ({
          ...NULL_VITALS,
          inp: 40,
          fcp: 250,
          lcp: 900,
          cls: 0.01,
        }),
      },
    });

    expect(result).toMatchObject({
      inpSource: 'state-hooks',
      fcp: 250,
      fcpSource: 'state-hooks',
      lcpSource: 'state-hooks',
      clsSource: 'state-hooks',
    });
  });

  it('records the hero mark when it is the only LCP source, and null where nothing was read', () => {
    const result = read({ heroMarks: [{ startTime: 700 }] });

    expect(result).toMatchObject({
      lcp: 700,
      lcpSource: 'hero-mark',
      fcp: null,
      fcpSource: null,
      cls: null,
      clsSource: null,
      inp: null,
      inpSource: null,
    });
  });
});

describe('startup lever at START_UI_SYNC', () => {
  const SYNC_BLOCK = 'BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS';
  const DOCUMENT_START = 'BENCHMARK_KNOWN_ANSWER_STARTUP_DELAY_MS';
  const START_UI_SYNC = {
    name: 'controller',
    data: { method: 'START_UI_SYNC', params: [{}] },
  };
  const savedEnv = {
    [SYNC_BLOCK]: process.env[SYNC_BLOCK],
    [DOCUMENT_START]: process.env[DOCUMENT_START],
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  describe('readStartupSyncBlockMs', () => {
    it('reads 0 when the switch is unset or empty', () => {
      delete process.env[SYNC_BLOCK];
      delete process.env[DOCUMENT_START];
      expect(readStartupSyncBlockMs()).toBe(0);
      process.env[SYNC_BLOCK] = '';
      expect(readStartupSyncBlockMs()).toBe(0);
    });

    it('reads 0 when the switch is 0', () => {
      process.env[SYNC_BLOCK] = '0';
      process.env[DOCUMENT_START] = '300';
      expect(readStartupSyncBlockMs()).toBe(0);
    });

    it('reads K when the switch is K', () => {
      process.env[SYNC_BLOCK] = '300';
      process.env[DOCUMENT_START] = '0';
      expect(readStartupSyncBlockMs()).toBe(300);
    });

    it('throws when the document-start lever is set too', () => {
      process.env[SYNC_BLOCK] = '300';
      process.env[DOCUMENT_START] = '151';
      expect(() => readStartupSyncBlockMs()).toThrow(
        'BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS and BENCHMARK_KNOWN_ANSWER_STARTUP_DELAY_MS are both set; set one startup lever at a time',
      );
    });

    it('rejects a value that is not a non-negative integer', () => {
      process.env[SYNC_BLOCK] = '30.5';
      expect(() => readStartupSyncBlockMs()).toThrow(
        'BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS must be a non-negative integer, got "30.5"',
      );
    });
  });

  describe('installStartUiSyncBlock', () => {
    it('registers nothing when the block is 0', async () => {
      const sendDevToolsCommand = jest.fn();
      const driver = { driver: { sendDevToolsCommand } } as unknown as Driver;

      await installStartUiSyncBlock(driver, 0);

      expect(sendDevToolsCommand).not.toHaveBeenCalled();
    });

    it('registers the block through CDP where the session has it', async () => {
      const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
      const driver = { driver: { sendDevToolsCommand } } as unknown as Driver;

      await installStartUiSyncBlock(driver, 300);

      expect(sendDevToolsCommand).toHaveBeenCalledTimes(1);
      expect(sendDevToolsCommand).toHaveBeenCalledWith(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: startUiSyncBlockSource(300) },
      );
    });

    it('registers a BiDi preload script where the session has BiDi', async () => {
      const send = jest.fn().mockResolvedValue({ result: { script: 'id' } });
      const driver = {
        driver: {
          getCapabilities: jest.fn().mockResolvedValue({
            get: (key: string) =>
              key === 'webSocketUrl'
                ? 'ws://localhost:1234/session'
                : undefined,
          }),
          getBidi: jest.fn().mockResolvedValue({ send }),
        },
      } as unknown as Driver;

      await installStartUiSyncBlock(driver, 300);

      expect(send).toHaveBeenCalledWith({
        method: 'script.addPreloadScript',
        params: {
          functionDeclaration: `() => { ${startUiSyncBlockSource(300)} }`,
        },
      });
    });

    it('throws rather than run a lever that cannot be registered', async () => {
      const driver = {
        driver: {
          getCapabilities: jest
            .fn()
            .mockResolvedValue({ get: () => undefined }),
          getBidi: jest.fn(),
        },
      } as unknown as Driver;

      await expect(installStartUiSyncBlock(driver, 300)).rejects.toThrow(
        'BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS is 300, but this session has neither CDP nor a WebDriver BiDi connection, so the block cannot be registered',
      );
    });
  });

  type Listener = (message: unknown, port: unknown) => void;
  type FakePort = {
    onMessage: {
      addListener: (fn: Listener) => void;
      removeListener: (fn: Listener) => void;
      hasListener: (fn: Listener) => boolean;
      hasListeners: () => boolean;
    };
  };

  /**
   * A page with `chrome.runtime.connect`, whose ports dispatch each message to
   * their listeners in order, as the browser does; and a `performance` that
   * records marks.
   *
   * @param options - The page.
   * @param options.topLevel - False for a child frame.
   */
  function fakePage({ topLevel = true }: { topLevel?: boolean } = {}) {
    const ports: { port: FakePort; listeners: Listener[] }[] = [];
    const connect = jest.fn((_options: { name: string }) => {
      const listeners: Listener[] = [];
      const port: FakePort = {
        onMessage: {
          addListener: (fn) => listeners.push(fn),
          removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1),
          hasListener: (fn) => listeners.includes(fn),
          hasListeners: () => listeners.length > 0,
        },
      };
      ports.push({ port, listeners });
      return port;
    });
    const marks: { name: string; startTime: number }[] = [];
    const pageWindow: Record<string, unknown> = {};
    pageWindow.top = topLevel ? pageWindow : {};
    const chrome = { runtime: { connect } };
    const pageSetTimeout = jest.fn();
    const context = {
      window: pageWindow,
      chrome,
      setTimeout: pageSetTimeout,
      performance: {
        now: () => performance.now(),
        mark: (name: string, options?: { startTime?: number }) => {
          marks.push({
            name,
            startTime: options?.startTime ?? performance.now(),
          });
        },
      },
    };
    return {
      context,
      connect,
      marks,
      setTimeout: pageSetTimeout,
      /** What the app calls: the page's `chrome.runtime.connect`. */
      open: (name: string) => chrome.runtime.connect({ name }) as FakePort,
      /** The browser delivering `message` on the `index`th port opened. */
      dispatch: (message: unknown, index = 0) => {
        const { port, listeners } = ports[index];
        for (const fn of listeners.slice()) {
          fn(message, port);
        }
      },
    };
  }

  describe('startUiSyncBlockSource', () => {
    it('blocks once, on the first START_UI_SYNC, before the app sees it, and marks the wait', () => {
      const page = fakePage();
      runInNewContext(startUiSyncBlockSource(30), page.context);
      const port = page.open('home');
      const seenAt: number[] = [];
      port.onMessage.addListener(() => seenAt.push(performance.now()));

      const before = performance.now();
      page.dispatch(START_UI_SYNC);
      const after = performance.now();

      expect(page.connect).toHaveBeenCalledWith({ name: 'home' });
      expect(after - before).toBeGreaterThanOrEqual(30);
      expect(page.marks.map((mark) => mark.name)).toStrictEqual([
        'mm-lever-start',
        'mm-lever-end',
      ]);
      const [start, end] = page.marks;
      expect(start.startTime).toBeGreaterThanOrEqual(before);
      expect(end.startTime - start.startTime).toBeGreaterThanOrEqual(30);
      expect(seenAt).toHaveLength(1);
      expect(seenAt[0]).toBeGreaterThanOrEqual(end.startTime);

      // A second START_UI_SYNC, on this port or another, does not block.
      page.dispatch(START_UI_SYNC);
      page.open('home');
      page.dispatch(START_UI_SYNC, 1);
      expect(seenAt).toHaveLength(2);
      expect(page.marks).toHaveLength(2);
    });

    it("delivers every other message at once, in order, to the app's listeners", () => {
      const page = fakePage();
      runInNewContext(startUiSyncBlockSource(200), page.context);
      const port = page.open('home');
      const first = jest.fn();
      const second = jest.fn();
      const removed = jest.fn();
      port.onMessage.addListener(first);
      port.onMessage.addListener(removed);
      port.onMessage.addListener(second);
      port.onMessage.removeListener(removed);
      const update = { name: 'controller', data: { method: 'sendUpdate' } };
      const providerSync = {
        name: 'provider',
        data: { method: 'START_UI_SYNC' },
      };

      const before = performance.now();
      page.dispatch(update);
      page.dispatch(providerSync);

      expect(performance.now() - before).toBeLessThan(100);
      expect(first.mock.calls).toStrictEqual([
        [update, port],
        [providerSync, port],
      ]);
      expect(second.mock.calls).toStrictEqual(first.mock.calls);
      expect(removed).not.toHaveBeenCalled();
      expect(port.onMessage.hasListener(first)).toBe(true);
      expect(port.onMessage.hasListener(removed)).toBe(false);
      expect(port.onMessage.hasListeners()).toBe(true);
      expect(page.marks).toStrictEqual([]);
    });

    it("calls the next listener when one throws, and rethrows the error outside the port's dispatch", () => {
      const page = fakePage();
      runInNewContext(startUiSyncBlockSource(1), page.context);
      const port = page.open('home');
      const error = new Error('listener failed');
      const next = jest.fn();
      port.onMessage.addListener(() => {
        throw error;
      });
      port.onMessage.addListener(next);

      page.dispatch(START_UI_SYNC);

      expect(next).toHaveBeenCalledTimes(1);
      expect(page.setTimeout).toHaveBeenCalledTimes(1);
      const [rethrow, delay] = page.setTimeout.mock.calls[0];
      expect(delay).toBe(0);
      expect(rethrow).toThrow(error);
    });

    it('wraps nothing in a child frame', () => {
      const page = fakePage({ topLevel: false });
      const { connect } = page.context.chrome.runtime;
      runInNewContext(startUiSyncBlockSource(200), page.context);

      expect(page.context.chrome.runtime.connect).toBe(connect);
    });

    it('does nothing on a page without chrome.runtime.connect', () => {
      const pageWindow: Record<string, unknown> = {};
      pageWindow.top = pageWindow;
      expect(() =>
        runInNewContext(startUiSyncBlockSource(200), {
          window: pageWindow,
          performance,
        }),
      ).not.toThrow();
    });
  });

  describe("the document-start lever's marks", () => {
    it('marks the start and end of the wait it ran', () => {
      const page = fakePage();
      const before = performance.now();
      runInNewContext(documentStartDelaySource(30), page.context);

      expect(page.marks.map((mark) => mark.name)).toStrictEqual([
        'mm-lever-start',
        'mm-lever-end',
      ]);
      const [start, end] = page.marks;
      expect(start.startTime).toBeGreaterThanOrEqual(before);
      expect(end.startTime - start.startTime).toBeGreaterThanOrEqual(30);
    });

    it('still waits when the page cannot mark', () => {
      const pageWindow: Record<string, unknown> = {};
      pageWindow.top = pageWindow;
      const start = performance.now();
      runInNewContext(documentStartDelaySource(30), {
        window: pageWindow,
        performance: { now: () => performance.now() },
      });
      expect(performance.now() - start).toBeGreaterThanOrEqual(30);
    });
  });

  describe('readStartupLeverMarks', () => {
    const originalGetEntriesByName = performance.getEntriesByName;

    afterEach(() => {
      performance.getEntriesByName = originalGetEntriesByName;
    });

    it('reads the first lever start and end marks in the page', async () => {
      performance.getEntriesByName = jest.fn((name: string) =>
        name === 'mm-lever-start'
          ? [{ startTime: 865 }, { startTime: 2000 }]
          : [{ startTime: 1165.2 }],
      ) as unknown as typeof performance.getEntriesByName;
      const driver = {
        executeScript: jest.fn((script: () => unknown) => script()),
      } as unknown as Driver;

      await expect(readStartupLeverMarks(driver)).resolves.toStrictEqual({
        start: 865,
        end: 1165.2,
      });
      expect(performance.getEntriesByName).toHaveBeenCalledWith(
        'mm-lever-start',
        'mark',
      );
      expect(performance.getEntriesByName).toHaveBeenCalledWith(
        'mm-lever-end',
        'mark',
      );
    });

    it('reads null for a mark the page does not have', async () => {
      performance.getEntriesByName = jest.fn().mockReturnValue([]);
      const driver = {
        executeScript: jest.fn((script: () => unknown) => script()),
      } as unknown as Driver;

      await expect(readStartupLeverMarks(driver)).resolves.toStrictEqual({
        start: null,
        end: null,
      });
    });
  });

  describe("runPageLoadBenchmark's lever marks", () => {
    const UI_STARTUP = [
      [999, 999, 999],
      [500, 100, 102],
      [500, 104, 106],
    ];

    it("keeps each measured page load's marks beside `values`, numbered and flagged as `values` is", async () => {
      const results = await runPageLoadBenchmark(
        browserLoadsOf(UI_STARTUP, (browserLoad) => ({
          leverMarks: [0, 1, 2].map((pageLoad) =>
            browserLoad === 2 && pageLoad === 1
              ? { start: null, end: null }
              : { start: 20 + pageLoad, end: 320 + pageLoad + browserLoad },
          ),
        })),
        { browserLoads: 3, pageLoads: 3 },
      );

      expect(results.leverMarks).toStrictEqual([
        { iteration: 3, start: 20, end: 321, excluded: 'first-page-load' },
        { iteration: 4, start: 21, end: 322 },
        { iteration: 5, start: 22, end: 323 },
        { iteration: 6, start: 20, end: 322, excluded: 'first-page-load' },
        { iteration: 7, start: null, end: null },
        { iteration: 8, start: 22, end: 324 },
      ]);
      const keys = Object.keys(results);
      expect(keys.indexOf('leverMarks')).toBe(keys.indexOf('values') + 1);
    });

    it('changes no series, and adds no key when no lever is set', async () => {
      const withMarks = await runPageLoadBenchmark(
        browserLoadsOf(UI_STARTUP, () => ({
          leverMarks: [0, 1, 2].map(() => ({ start: 20, end: 320 })),
        })),
        { browserLoads: 3, pageLoads: 3 },
      );
      const without = await runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
        browserLoads: 3,
        pageLoads: 3,
      });

      expect(without).not.toHaveProperty('leverMarks');
      const { leverMarks: _leverMarks, ...rest } = withMarks;
      expect(rest).toStrictEqual(without);
    });
  });
});

describe('startup post-hero long tasks', () => {
  const SWITCH = 'BENCHMARK_STARTUP_POST_HERO_LONG_TASKS';
  const savedSwitch = process.env[SWITCH];

  afterEach(() => {
    if (savedSwitch === undefined) {
      delete process.env[SWITCH];
    } else {
      process.env[SWITCH] = savedSwitch;
    }
  });

  describe('isStartupPostHeroLongTasksOn', () => {
    it('is off when the switch is unset, empty or 0', () => {
      delete process.env[SWITCH];
      expect(isStartupPostHeroLongTasksOn()).toBe(false);
      process.env[SWITCH] = '';
      expect(isStartupPostHeroLongTasksOn()).toBe(false);
      process.env[SWITCH] = '0';
      expect(isStartupPostHeroLongTasksOn()).toBe(false);
    });

    it('is off for any other value than 1', () => {
      for (const value of ['true', '2', ' 1', '01']) {
        process.env[SWITCH] = value;
        expect(isStartupPostHeroLongTasksOn()).toBe(false);
      }
    });

    it('is on when the switch is 1', () => {
      process.env[SWITCH] = '1';
      expect(isStartupPostHeroLongTasksOn()).toBe(true);
    });
  });

  describe('selectPostHeroLongTasks', () => {
    const HERO = 800;

    /**
     * What `readStartupPageSignals` returns for a page whose observer ran.
     *
     * @param tasks - The tasks the app stored.
     * @param overrides - Fields to replace.
     */
    function signalsWith(
      tasks: LongTaskRecord['tasks'],
      overrides: Partial<StartupPageSignals> = {},
    ): StartupPageSignals {
      return {
        heroPainted: HERO,
        longTasks: { observed: true, count: tasks.length, tasks },
        ...overrides,
      };
    }

    it('leaves out a task that starts before the hero mark and keeps one at or after it', () => {
      const result = selectPostHeroLongTasks(
        signalsWith([
          { startTime: 120, duration: 300 },
          { startTime: HERO - 0.1, duration: 90 },
          { startTime: HERO, duration: 51 },
          { startTime: HERO + 38, duration: 87 },
        ]),
        2000,
      );

      expect(result).toStrictEqual({
        tasks: [
          { start: 0, duration: 51, beforeUiStartupEnd: true },
          { start: 38, duration: 87, beforeUiStartupEnd: true },
        ],
        notStored: 0,
      });
    });

    it('flags whether each task starts at or before the end of uiStartup', () => {
      const result = selectPostHeroLongTasks(
        signalsWith([
          { startTime: 810, duration: 60 },
          { startTime: 900, duration: 70 },
          { startTime: 900.5, duration: 80 },
          { startTime: 1500, duration: 120 },
        ]),
        900,
      );

      expect(
        result.tasks?.map((task) => task.beforeUiStartupEnd),
      ).toStrictEqual([true, true, false, false]);
    });

    it('flags neither side when the end of uiStartup is unknown', () => {
      const tasks = [{ startTime: 810, duration: 60 }];
      for (const unknownEnd of [undefined, Number.NaN]) {
        expect(
          selectPostHeroLongTasks(signalsWith(tasks), unknownEnd).tasks,
        ).toStrictEqual([
          { start: 10, duration: 60, beforeUiStartupEnd: null },
        ]);
      }
    });

    it("draws the line at uiStartup's end where the long-task series do", () => {
      const record: LongTaskRecord = {
        observed: true,
        count: 6,
        tasks: [
          { startTime: 100, duration: 80 },
          { startTime: 700, duration: 60 },
          { startTime: 810, duration: 55 },
          { startTime: 900, duration: 70 },
          { startTime: 901, duration: 65 },
          { startTime: 1500, duration: 120 },
        ],
      };
      const end = 900;

      const bound = boundLongTasksToStartup(record, end);
      const { tasks } = selectPostHeroLongTasks(
        { heroPainted: HERO, longTasks: record },
        end,
      );

      const beforeHeroInWindow = record.tasks.filter(
        (task) => task.startTime < HERO && task.startTime <= end,
      ).length;
      const afterHeroInWindow =
        tasks?.filter((task) => task.beforeUiStartupEnd).length ?? 0;
      expect(bound?.longTaskCount).toBe(4);
      expect(beforeHeroInWindow + afterHeroInWindow).toBe(bound?.longTaskCount);
    });

    it('returns an empty list when the observer ran and no task started after the hero mark', () => {
      expect(
        selectPostHeroLongTasks(
          signalsWith([{ startTime: 300, duration: 120 }]),
          1000,
        ),
      ).toStrictEqual({ tasks: [], notStored: 0 });
      expect(selectPostHeroLongTasks(signalsWith([]), 1000)).toStrictEqual({
        tasks: [],
        notStored: 0,
      });
    });

    it('says how many long tasks the app counted and did not store', () => {
      const stored = Array.from({ length: 50 }, (_, i) => ({
        startTime: HERO + i,
        duration: 60,
      }));
      const signals = signalsWith(stored);
      signals.longTasks = { observed: true, count: 60, tasks: stored };

      const result = selectPostHeroLongTasks(signals, 5000);

      expect(result.tasks).toHaveLength(50);
      expect(result).toHaveProperty('notStored', 10);
    });

    it('returns null tasks, and why, when the load cannot say', () => {
      expect(
        selectPostHeroLongTasks({ heroPainted: HERO, longTasks: null }, 1000),
      ).toStrictEqual({ tasks: null, unavailable: 'no-long-task-hook' });
      expect(
        selectPostHeroLongTasks(
          {
            heroPainted: HERO,
            longTasks: { observed: false, count: 0, tasks: [] },
          },
          1000,
        ),
      ).toStrictEqual({ tasks: null, unavailable: 'observer-not-attached' });
      expect(
        selectPostHeroLongTasks(
          signalsWith([{ startTime: 810, duration: 60 }], {
            heroPainted: null,
          }),
          1000,
        ),
      ).toStrictEqual({ tasks: null, unavailable: 'no-hero-mark' });
    });
  });

  describe("runPageLoadBenchmark's post-hero long tasks", () => {
    const UI_STARTUP = [
      [999, 999, 999],
      [500, 100, 102],
      [500, 104, 106],
    ];

    it("keeps each measured page load's list beside `values`, numbered and flagged as `values` is", async () => {
      const results = await runPageLoadBenchmark(
        browserLoadsOf(UI_STARTUP, (browserLoad) => ({
          leverMarks: [0, 1, 2].map(() => ({ start: 20, end: 320 })),
          postHeroLongTasks: [0, 1, 2].map((pageLoad) =>
            browserLoad === 2 && pageLoad === 1
              ? { tasks: null, unavailable: 'no-hero-mark' as const }
              : {
                  tasks: [
                    {
                      start: 12 + pageLoad,
                      duration: 50 + browserLoad,
                      beforeUiStartupEnd: pageLoad === 0,
                    },
                  ],
                  notStored: 0,
                },
          ),
        })),
        { browserLoads: 3, pageLoads: 3 },
      );

      expect(results.postHeroLongTasks).toStrictEqual([
        {
          iteration: 3,
          tasks: [{ start: 12, duration: 51, beforeUiStartupEnd: true }],
          notStored: 0,
          excluded: 'first-page-load',
        },
        {
          iteration: 4,
          tasks: [{ start: 13, duration: 51, beforeUiStartupEnd: false }],
          notStored: 0,
        },
        {
          iteration: 5,
          tasks: [{ start: 14, duration: 51, beforeUiStartupEnd: false }],
          notStored: 0,
        },
        {
          iteration: 6,
          tasks: [{ start: 12, duration: 52, beforeUiStartupEnd: true }],
          notStored: 0,
          excluded: 'first-page-load',
        },
        { iteration: 7, tasks: null, unavailable: 'no-hero-mark' },
        {
          iteration: 8,
          tasks: [{ start: 14, duration: 52, beforeUiStartupEnd: false }],
          notStored: 0,
        },
      ]);
      const keys = Object.keys(results);
      expect(keys.indexOf('postHeroLongTasks')).toBe(
        keys.indexOf('leverMarks') + 1,
      );
      expect(keys.indexOf('leverMarks')).toBe(keys.indexOf('values') + 1);
    });

    it('changes no series, and adds no key when the flow records none', async () => {
      const withTasks = await runPageLoadBenchmark(
        browserLoadsOf(UI_STARTUP, () => ({
          postHeroLongTasks: [0, 1, 2].map(() => ({
            tasks: [{ start: 12, duration: 60, beforeUiStartupEnd: true }],
            notStored: 0,
          })),
        })),
        { browserLoads: 3, pageLoads: 3 },
      );
      const without = await runPageLoadBenchmark(browserLoadsOf(UI_STARTUP), {
        browserLoads: 3,
        pageLoads: 3,
      });

      expect(without).not.toHaveProperty('postHeroLongTasks');
      const { postHeroLongTasks: _postHeroLongTasks, ...rest } = withTasks;
      expect(rest).toStrictEqual(without);
    });
  });
});
