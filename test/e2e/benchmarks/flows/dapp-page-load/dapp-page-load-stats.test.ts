import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { WARMUP_RUNS } from '../../utils/constants';
import type { DappPageLoadSample } from '../../utils/types';
import {
  DAPP_SCRIPT_ROUTE_CONTROL,
  KNOWN_ANSWER_DAPP_SCRIPT_DELAY,
  LCP_READ_TIMEOUT_MS,
  LOCAL_STYLESHEET_DIRECTORY,
  TEST_DAPP_OFF_HOST_STYLESHEETS,
  localizeOffHostStylesheets,
  readLargestContentfulPaint,
  shouldRouteDappScript,
} from './dapp-page-load-benchmark';
import {
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
