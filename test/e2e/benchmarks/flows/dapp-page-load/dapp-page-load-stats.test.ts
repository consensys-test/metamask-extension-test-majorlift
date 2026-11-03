import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { performance as nodePerformance } from 'perf_hooks';
import vm from 'vm';
import { WARMUP_RUNS } from '../../utils/constants';
import type { DappPageLoadSample } from '../../utils/types';
import {
  DAPP_SCRIPT_ROUTE_CONTROL,
  DAPP_SCRIPT_WORK_MEASURE,
  KNOWN_ANSWER_DAPP_SCRIPT_DELAY,
  KNOWN_ANSWER_DAPP_SCRIPT_WORK,
  LCP_READ_TIMEOUT_MS,
  LONG_TASK_READ_TIMEOUT_MS,
  LOCAL_STYLESHEET_DIRECTORY,
  PageLoadBenchmark,
  TEST_DAPP_OFF_HOST_STYLESHEETS,
  dappScriptWorkPrefix,
  getDappScriptWorkMs,
  localizeOffHostStylesheets,
  prependDappScriptWork,
  readDappScriptProbe,
  readLargestContentfulPaint,
  shouldRouteDappScript,
} from './dapp-page-load-benchmark';
import {
  addDappPageLoadProbe,
  aggregateDappPageLoadStatistics,
  dappPageLoadStatsToBenchmarkResults,
  getFirstMeasuredRun,
} from './dapp-page-load-stats';

describe('dapp-page-load-stats', () => {
  describe('aggregateDappPageLoadStatistics', () => {
    it('groups by page and produces timers with ids matching metric keys', () => {
      const samples: DappPageLoadSample[] = [
        {
          page: 'https://example.test/',
          run: 0,
          timestamp: 1,
          metrics: {
            pageLoadTime: 100,
            domContentLoaded: 40,
            firstPaint: 10,
            firstContentfulPaint: 20,
            largestContentfulPaint: 50,
          },
        },
        {
          page: 'https://example.test/',
          run: 1,
          timestamp: 2,
          metrics: {
            pageLoadTime: 120,
            domContentLoaded: 45,
            firstPaint: 12,
            firstContentfulPaint: 22,
            largestContentfulPaint: 55,
          },
        },
      ];

      const stats = aggregateDappPageLoadStatistics(samples);

      expect(stats).toHaveLength(1);
      expect(stats[0].page).toBe('https://example.test/');
      const ids = stats[0].timers.map((t) => t.id).sort();
      expect(ids).toEqual([
        'domContentLoaded',
        'firstContentfulPaint',
        'firstPaint',
        'largestContentfulPaint',
        'pageLoadTime',
      ]);
      const plt = stats[0].timers.find((t) => t.id === 'pageLoadTime');
      expect(plt?.samples).toBe(2);
      expect(plt?.mean).toBeGreaterThan(0);
    });
  });

  describe('dappPageLoadStatsToBenchmarkResults', () => {
    it('writes BenchmarkResults under dappPageLoad', () => {
      const samples: DappPageLoadSample[] = [
        {
          page: 'p',
          run: 0,
          timestamp: 1,
          metrics: {
            pageLoadTime: 100,
            domContentLoaded: 40,
            firstPaint: 10,
            firstContentfulPaint: 20,
            largestContentfulPaint: 50,
          },
        },
      ];
      const stats = aggregateDappPageLoadStatistics(samples);
      const out = dappPageLoadStatsToBenchmarkResults(stats);

      expect(out.dappPageLoad).toBeDefined();
      expect(out.dappPageLoad.testTitle).toBe('dappPageLoad');
      expect(out.dappPageLoad.mean.pageLoadTime).toBeGreaterThan(0);
    });
  });
});

function sample(
  run: number,
  metrics: Partial<DappPageLoadSample['metrics']> = {},
): DappPageLoadSample {
  return {
    page: 'p',
    run,
    timestamp: run,
    metrics: {
      pageLoadTime: 100 + run,
      domContentLoaded: 40 + run,
      firstPaint: 10 + run,
      firstContentfulPaint: 20 + run,
      largestContentfulPaint: 50 + run,
      ...metrics,
    },
  };
}

describe('per-page-load values', () => {
  it('keeps every page load value, untrimmed, under its run number', () => {
    const samples = [
      sample(0),
      sample(1, { firstContentfulPaint: 0 }),
      sample(2),
    ];

    const [{ timers }] = aggregateDappPageLoadStatistics(samples);
    const fcp = timers.find((t) => t.id === 'firstContentfulPaint');

    // The zero fails the sanity floor, so it is out of the statistics and
    // still in `values`, where a reader can see it was dropped.
    expect(fcp?.samples).toBe(2);
    expect(fcp?.values).toStrictEqual([
      { iteration: 0, value: 20 },
      { iteration: 1, value: 0 },
      { iteration: 2, value: 22 },
    ]);
  });

  it('carries the values into the benchmark results for every series', () => {
    const out = dappPageLoadStatsToBenchmarkResults(
      aggregateDappPageLoadStatistics([sample(0), sample(1)]),
    );

    expect(Object.keys(out.dappPageLoad.values ?? {}).sort()).toStrictEqual([
      'domContentLoaded',
      'firstContentfulPaint',
      'firstPaint',
      'largestContentfulPaint',
      'pageLoadTime',
    ]);
    expect(out.dappPageLoad.values?.pageLoadTime).toStrictEqual([
      { iteration: 0, value: 100 },
      { iteration: 1, value: 101 },
    ]);
  });
});

describe('warm-up', () => {
  it('starts measuring after the first browser load', () => {
    expect(getFirstMeasuredRun(10, 10)).toBe(WARMUP_RUNS * 10);
    expect(getFirstMeasuredRun(WARMUP_RUNS + 1, 3)).toBe(WARMUP_RUNS * 3);
  });

  it('refuses a job with no browser load left to measure', () => {
    expect(() => getFirstMeasuredRun(WARMUP_RUNS, 10)).toThrow(
      `browserLoads (${WARMUP_RUNS}) must be greater than WARMUP_RUNS`,
    );
  });

  it('leaves warm-up page loads out of the statistics and the values', () => {
    // Two browser loads of two page loads: runs 0 and 1 are the first
    // browser load, slow as a cold cache would make them.
    const samples = [
      sample(0, { pageLoadTime: 3000 }),
      sample(1, { pageLoadTime: 2900 }),
      sample(2, { pageLoadTime: 500 }),
      sample(3, { pageLoadTime: 520 }),
    ];

    const [{ timers }] = aggregateDappPageLoadStatistics(samples, {
      firstMeasuredRun: getFirstMeasuredRun(2, 2),
    });
    const plt = timers.find((t) => t.id === 'pageLoadTime');

    expect(plt?.samples).toBe(2);
    expect(plt?.mean).toBe(510);
    expect(plt?.values).toStrictEqual([
      { iteration: 2, value: 500 },
      { iteration: 3, value: 520 },
    ]);
  });

  it('keeps every sample when no warm-up is given', () => {
    const [{ timers }] = aggregateDappPageLoadStatistics([
      sample(0),
      sample(1),
    ]);

    expect(timers.find((t) => t.id === 'pageLoadTime')?.samples).toBe(2);
  });
});

describe('off-host stylesheets', () => {
  const testDappIndex = path.join(
    process.cwd(),
    'node_modules/@metamask/test-dapp/dist/index.html',
  );

  it('points every off-host stylesheet of the installed test dapp at a local copy', () => {
    const localized = localizeOffHostStylesheets(
      readFileSync(testDappIndex, 'utf8'),
    );

    for (const [url, fileName] of Object.entries(
      TEST_DAPP_OFF_HOST_STYLESHEETS,
    )) {
      expect(localized).not.toContain(url);
      expect(localized).toContain(
        `href="${LOCAL_STYLESHEET_DIRECTORY}/${fileName}"`,
      );
    }
    expect(localized).not.toMatch(/<link\b[^>]*\bhref="https?:/u);
  });

  it('has a local copy for every stylesheet it maps', () => {
    for (const fileName of Object.values(TEST_DAPP_OFF_HOST_STYLESHEETS)) {
      expect(
        existsSync(path.join(__dirname, LOCAL_STYLESHEET_DIRECTORY, fileName)),
      ).toBe(true);
    }
  });

  it('fails when a stylesheet it maps is no longer linked', () => {
    const [firstUrl] = Object.keys(TEST_DAPP_OFF_HOST_STYLESHEETS);
    const html = readFileSync(testDappIndex, 'utf8').replace(
      `href="${firstUrl}"`,
      'href="index.css"',
    );

    expect(() => localizeOffHostStylesheets(html)).toThrow(
      `links ${firstUrl} 0 times; expected once`,
    );
  });

  it('fails when an off-host stylesheet with no local copy remains', () => {
    const html = readFileSync(testDappIndex, 'utf8').replace(
      '<link rel="stylesheet" href="index.css" type="text/css" />',
      '<link rel="stylesheet" href="https://cdn.example/extra.css" />',
    );

    expect(() => localizeOffHostStylesheets(html)).toThrow(
      'off-host resources with no local copy: https://cdn.example/extra.css',
    );
  });
});

describe('largest contentful paint', () => {
  type ObserverCallback = (list: {
    getEntries: () => { startTime: number }[];
  }) => void;

  let callback: ObserverCallback | undefined;
  const observe = jest.fn();
  const disconnect = jest.fn();
  const originalObserver = globalThis.PerformanceObserver;

  beforeEach(() => {
    callback = undefined;
    observe.mockReset();
    disconnect.mockReset();
    globalThis.PerformanceObserver = class {
      constructor(cb: ObserverCallback) {
        callback = cb;
      }

      observe = observe;

      disconnect = disconnect;
    } as unknown as typeof PerformanceObserver;
  });

  afterEach(() => {
    globalThis.PerformanceObserver = originalObserver;
    jest.useRealTimers();
  });

  it('reads the last buffered candidate through a buffered observer', async () => {
    jest.useFakeTimers();
    const read = readLargestContentfulPaint(LCP_READ_TIMEOUT_MS);
    callback?.({ getEntries: () => [{ startTime: 120 }, { startTime: 332 }] });
    // The timeout firing afterwards does not replace the value read.
    jest.advanceTimersByTime(LCP_READ_TIMEOUT_MS);

    expect(await read).toBe(332);
    expect(observe).toHaveBeenCalledWith({
      type: 'largest-contentful-paint',
      buffered: true,
    });
    expect(disconnect).toHaveBeenCalled();
  });

  it('reads 0 when no candidate arrives within the timeout', async () => {
    jest.useFakeTimers();
    const read = readLargestContentfulPaint(LCP_READ_TIMEOUT_MS);
    jest.advanceTimersByTime(LCP_READ_TIMEOUT_MS);

    expect(await read).toBe(0);
    expect(disconnect).toHaveBeenCalled();
  });
});

describe('known-answer lever on the dapp script', () => {
  afterEach(() => {
    delete process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY];
    delete process.env[DAPP_SCRIPT_ROUTE_CONTROL];
  });

  it('routes nothing when neither the lever nor the control is set', () => {
    expect(shouldRouteDappScript()).toBe(false);
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '0';
    expect(shouldRouteDappScript()).toBe(false);
  });

  it('routes the script when the lever is above 0, or the control is on', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '300';
    expect(shouldRouteDappScript()).toBe(true);

    delete process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY];
    process.env[DAPP_SCRIPT_ROUTE_CONTROL] = '1';
    expect(shouldRouteDappScript()).toBe(true);
  });

  it('rejects a lever value that is not a non-negative integer', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '-5';
    expect(() => shouldRouteDappScript()).toThrow('non-negative integer');
  });
});

describe('known-answer busy-wait on the dapp script', () => {
  afterEach(() => {
    delete process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK];
    delete process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY];
    delete process.env[DAPP_SCRIPT_ROUTE_CONTROL];
  });

  it('is off when unset or empty', () => {
    expect(getDappScriptWorkMs()).toBeUndefined();
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '';
    expect(getDappScriptWorkMs()).toBeUndefined();
  });

  it('is on at 0 and at K', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '0';
    expect(getDappScriptWorkMs()).toBe(0);
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '153';
    expect(getDappScriptWorkMs()).toBe(153);
  });

  it('rejects a value that is not a non-negative integer', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '-5';
    expect(() => getDappScriptWorkMs()).toThrow('non-negative integer');
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '1.5';
    expect(() => getDappScriptWorkMs()).toThrow('non-negative integer');
  });

  it('throws when the route lever is also set, at any value', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '153';
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '153';
    expect(() => getDappScriptWorkMs()).toThrow(
      `${KNOWN_ANSWER_DAPP_SCRIPT_WORK} cannot be set with ${KNOWN_ANSWER_DAPP_SCRIPT_DELAY}`,
    );
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '0';
    expect(() => getDappScriptWorkMs()).toThrow('cannot be set with');
  });

  it('throws when the route control is also on', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = '0';
    process.env[DAPP_SCRIPT_ROUTE_CONTROL] = '1';
    expect(() => getDappScriptWorkMs()).toThrow('cannot be set with');
  });

  it('leaves the route lever alone when the busy-wait is unset', () => {
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '153';
    process.env[DAPP_SCRIPT_ROUTE_CONTROL] = '1';
    expect(getDappScriptWorkMs()).toBeUndefined();
  });

  it('installs no route at 0 or at K, where the route lever installs one', async () => {
    const route = jest.fn();
    const benchmark = new PageLoadBenchmark('unused');
    const internals = benchmark as unknown as {
      context: { route: typeof route };
      installDappScriptRoute: () => Promise<void>;
    };
    internals.context = { route };

    for (const workMs of ['0', '153']) {
      process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK] = workMs;
      expect(shouldRouteDappScript()).toBe(false);
      await internals.installDappScriptRoute();
    }
    expect(route).not.toHaveBeenCalled();

    // The same context records the route lever's route, so the check above
    // can see one.
    delete process.env[KNOWN_ANSWER_DAPP_SCRIPT_WORK];
    process.env[KNOWN_ANSWER_DAPP_SCRIPT_DELAY] = '153';
    await internals.installDappScriptRoute();
    expect(route).toHaveBeenCalledTimes(1);
  });

  describe('the prefix', () => {
    let directory: string;

    beforeEach(() => {
      directory = mkdtempSync(path.join(os.tmpdir(), 'dapp-script-work-'));
    });

    afterEach(() => {
      rmSync(directory, { recursive: true, force: true });
      nodePerformance.clearMeasures(DAPP_SCRIPT_WORK_MEASURE);
    });

    it('is written before the script, byte for byte, with its file times kept', async () => {
      const scriptPath = path.join(directory, 'main.js');
      // A byte sequence that is not UTF-8, so a text round trip would show.
      const original = Buffer.concat([
        Buffer.from('(()=>{window.x=1})();'),
        Buffer.from([0xff, 0xfe, 0x0a]),
      ]);
      writeFileSync(scriptPath, original);
      const atime = new Date('2026-09-09T10:50:00Z');
      const mtime = new Date('2026-09-09T10:50:01Z');
      utimesSync(scriptPath, atime, mtime);

      await prependDappScriptWork(scriptPath, 153);

      // Times first: reading the file afterwards may move its atime.
      const after = statSync(scriptPath);
      expect(after.atimeMs).toBe(atime.getTime());
      expect(after.mtimeMs).toBe(mtime.getTime());
      expect(readFileSync(scriptPath)).toStrictEqual(
        Buffer.concat([Buffer.from(dappScriptWorkPrefix(153)), original]),
      );
    });

    it('spins for at least K and records its measure', () => {
      const workMs = 20;
      vm.runInNewContext(dappScriptWorkPrefix(workMs), {
        performance: nodePerformance,
      });

      const measures = nodePerformance.getEntriesByName(
        DAPP_SCRIPT_WORK_MEASURE,
        'measure',
      );
      expect(measures).toHaveLength(1);
      expect(measures[0].duration).toBeGreaterThanOrEqual(workMs);
    });

    it('records a measure at 0 too', () => {
      vm.runInNewContext(dappScriptWorkPrefix(0), {
        performance: nodePerformance,
      });

      expect(
        nodePerformance.getEntriesByName(DAPP_SCRIPT_WORK_MEASURE, 'measure'),
      ).toHaveLength(1);
    });

    it('goes before a script that opens with no directive prologue', () => {
      // A leading `'use strict'` would become a plain expression after the
      // prefix. The installed test dapp's main.js opens with an arrow IIFE.
      const head = Buffer.alloc(6);
      const fd = openSync(
        path.join(
          process.cwd(),
          'node_modules/@metamask/test-dapp/dist/main.js',
        ),
        'r',
      );
      try {
        readSync(fd, head, 0, head.length, 0);
      } finally {
        closeSync(fd);
      }
      expect(head.toString('utf8')).toBe('(()=>{');
    });
  });
});

describe('probe', () => {
  // jsdom's `performance` is a getter with no setter, and records no
  // resource, measure or long-task entries, so the page's is stood in for.
  const performanceDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'performance',
  );
  const originalObserver = globalThis.PerformanceObserver;
  const scriptUrl = 'http://127.0.0.1:8080/main.js';
  const names = {
    measureName: DAPP_SCRIPT_WORK_MEASURE,
    scriptUrl,
    timeoutMs: LONG_TASK_READ_TIMEOUT_MS,
  };
  // main.js's evaluation, which holds the busy-wait; two tasks after the
  // busy-wait ends, before the load event; one after the load event.
  const longTasks = [
    { startTime: 100, duration: 300 },
    { startTime: 400, duration: 60 },
    { startTime: 500, duration: 120 },
    { startTime: 900, duration: 80 },
  ];
  type ObserverCallback = (list: { getEntries: () => object[] }) => void;
  let callback: ObserverCallback | undefined;

  function standIn({
    measure = true,
    supported = ['longtask'],
  }: { measure?: boolean; supported?: string[] } = {}) {
    const entries: Record<string, object[]> = {
      [`${DAPP_SCRIPT_WORK_MEASURE}/measure`]: measure
        ? [{ startTime: 100, duration: 153.2 }]
        : [],
      [`${scriptUrl}/resource`]: [{ startTime: 12.5, responseEnd: 210.4 }],
    };
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: {
        getEntriesByName: (name: string, type: string) =>
          entries[`${name}/${type}`] ?? [],
        getEntriesByType: (type: string) =>
          type === 'navigation' ? [{ loadEventEnd: 800 }] : [],
      },
    });
    callback = undefined;
    globalThis.PerformanceObserver = class {
      static supportedEntryTypes = supported;

      constructor(cb: ObserverCallback) {
        callback = cb;
      }

      observe = jest.fn();

      disconnect = jest.fn();
    } as unknown as typeof PerformanceObserver;
  }

  afterEach(() => {
    if (performanceDescriptor) {
      Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    }
    globalThis.PerformanceObserver = originalObserver;
    jest.useRealTimers();
  });

  it('reads the busy-wait measure, the script timing and the long tasks after the busy-wait', async () => {
    standIn();
    const read = readDappScriptProbe(names);
    callback?.({ getEntries: () => longTasks });

    expect(await read).toStrictEqual({
      scriptWorkMs: 153.2,
      scriptStartTime: 12.5,
      scriptResponseEnd: 210.4,
      longTaskCount: 3,
      afterWorkLongTaskCount: 2,
      afterWorkLongTaskTotalMs: 180,
      afterWorkLongTaskLongestMs: 120,
    });
  });

  it('reads null for each entry the page did not record', async () => {
    standIn({ measure: false });
    const read = readDappScriptProbe({
      ...names,
      scriptUrl: 'http://elsewhere/main.js',
    });
    callback?.({ getEntries: () => longTasks });

    expect(await read).toStrictEqual({
      scriptWorkMs: null,
      scriptStartTime: null,
      scriptResponseEnd: null,
      longTaskCount: 3,
      afterWorkLongTaskCount: null,
      afterWorkLongTaskTotalMs: null,
      afterWorkLongTaskLongestMs: null,
    });
  });

  it('reads 0 long tasks when none arrive within the timeout', async () => {
    jest.useFakeTimers();
    standIn();
    const read = readDappScriptProbe(names);
    jest.advanceTimersByTime(LONG_TASK_READ_TIMEOUT_MS);

    expect(await read).toMatchObject({
      longTaskCount: 0,
      afterWorkLongTaskCount: 0,
      afterWorkLongTaskTotalMs: 0,
      afterWorkLongTaskLongestMs: 0,
    });
  });

  it('reads null long tasks where the browser does not support them', async () => {
    standIn({ supported: [] });

    expect(await readDappScriptProbe(names)).toMatchObject({
      scriptWorkMs: 153.2,
      longTaskCount: null,
      afterWorkLongTaskCount: null,
      afterWorkLongTaskTotalMs: null,
      afterWorkLongTaskLongestMs: null,
    });
    expect(callback).toBeUndefined();
  });

  it('goes beside values, every load included, and changes no series', () => {
    const probeOf = (run: number) => ({
      scriptWorkMs: 153 + run / 10,
      scriptStartTime: 10 + run,
      scriptResponseEnd: 200 + run,
      longTaskCount: 2 + run,
      afterWorkLongTaskCount: run,
      afterWorkLongTaskTotalMs: 60 * run,
      afterWorkLongTaskLongestMs: run === 0 ? 0 : 60,
    });
    const samples = [0, 1, 2, 3].map((run) => ({
      ...sample(run),
      probe: probeOf(run),
    }));
    const results = dappPageLoadStatsToBenchmarkResults(
      aggregateDappPageLoadStatistics(samples, {
        firstMeasuredRun: getFirstMeasuredRun(2, 2),
      }),
    );
    const block = results.dappPageLoad;
    const keys = Object.keys(block);

    const out = addDappPageLoadProbe(results, {
      samples,
      serviceWorkers: 0,
    });

    const { probe, serviceWorkers, ...rest } = out.dappPageLoad as Record<
      string,
      unknown
    >;
    expect(probe).toStrictEqual(
      [0, 1, 2, 3].map((run) => ({ iteration: run, ...probeOf(run) })),
    );
    expect(serviceWorkers).toBe(0);
    // Every other key, `values` and each statistic included, is the input's.
    expect(rest).toStrictEqual(block);
    expect(results.dappPageLoad).toBe(block);
    expect(Object.keys(block)).toStrictEqual(keys);
  });
});
