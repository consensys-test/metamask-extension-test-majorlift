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
  convertTimerStatisticsToBenchmarkResults,
  documentStartDelaySource,
  installDocumentStartDelay,
  readStartupPageSignals,
  retryBrowserLoad,
  runBenchmarkWithIterations,
  runPageLoadBenchmark,
  waitForNetworkQuiet,
} from './runner';
import type {
  LongTaskRecord,
  PreparedWebVitalsRun,
  StartupMeasurePageResult,
} from './runner';
import type { BenchmarkRunResult, Metrics } from './types';

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
