import { promises as fs } from 'fs';
import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';
import {
  chromium,
  type BrowserContext,
  Browser,
  type Route,
} from '@playwright/test';
import {
  DEFAULT_BENCHMARK_BROWSER_LOADS,
  DEFAULT_BENCHMARK_PAGE_LOADS,
} from '../../../../../shared/constants/benchmarks';
import type {
  DappPageLoadMetric,
  DappPageLoadSample,
  DappPageLoadStats,
} from '../../utils/types';
import { DAPP_URL } from '../../../constants';
import {
  getKnownAnswerDelayMs,
  withKnownAnswerDelay,
} from '../../mocks/known-answer';
import {
  aggregateDappPageLoadStatistics,
  getFirstMeasuredRun,
} from './dapp-page-load-stats';

/**
 * How long to wait for the static dapp server to report that it is accepting
 * connections. Exceeding this is a failure rather than a fallback: a benchmark
 * that navigates before the server binds measures nothing.
 */
const DAPP_SERVER_READY_TIMEOUT_MS = 30_000;

/**
 * The test dapp's off-host stylesheets, keyed by the exact URL its
 * `index.html` links, each mapped to a local copy in
 * {@link LOCAL_STYLESHEET_DIRECTORY}. They are render-blocking, so served
 * from their CDNs they put CDN latency inside the paint series, which no
 * extension change can move. The copies are byte-identical to what each URL
 * served on 2026-10-30 (sha256 `96b5b882…dc82`, `2ff5b959…ebfd6`,
 * `fa2a2049…beb4`, in this order); the Google Fonts one was requested with
 * the user agent this benchmark sets, since that service varies its CSS by
 * user agent. The fonts that CSS names stay on `fonts.gstatic.com`.
 */
export const TEST_DAPP_OFF_HOST_STYLESHEETS: Readonly<Record<string, string>> =
  {
    'https://fonts.googleapis.com/css?family=Roboto:300,400,500,700&display=swap':
      'roboto.css',
    'https://cdnjs.cloudflare.com/ajax/libs/twitter-bootstrap/4.4.1/css/bootstrap.min.css':
      'bootstrap.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/mdbootstrap/4.14.1/css/mdb.min.css':
      'mdb.min.css',
  };

/**
 * Where the local stylesheet copies live, beside this file, and the path the
 * rewritten `index.html` links them under.
 */
export const LOCAL_STYLESHEET_DIRECTORY = 'test-dapp-styles';

/**
 * Point the test dapp's off-host stylesheet links at the local copies.
 *
 * Throws when a link this benchmark knows is absent or repeated, or when
 * another off-host stylesheet remains, so a test dapp upgrade that changes
 * its links fails here instead of quietly going back to a CDN.
 *
 * @param html - The test dapp's `index.html`.
 * @returns The same document, linking the local copies.
 */
export function localizeOffHostStylesheets(html: string): string {
  let localized = html;
  for (const [url, fileName] of Object.entries(
    TEST_DAPP_OFF_HOST_STYLESHEETS,
  )) {
    const link = `href="${url}"`;
    const count = localized.split(link).length - 1;
    if (count !== 1) {
      throw new Error(
        `The test dapp's index.html links ${url} ${count} times; expected once. Update TEST_DAPP_OFF_HOST_STYLESHEETS to match it.`,
      );
    }
    localized = localized.replace(
      link,
      `href="${LOCAL_STYLESHEET_DIRECTORY}/${fileName}"`,
    );
  }
  const remaining = [
    ...localized.matchAll(/<link\b[^>]*\bhref="(https?:\/\/[^"]+)"/gu),
  ].map((match) => match[1]);
  if (remaining.length > 0) {
    throw new Error(
      `The test dapp's index.html links off-host resources with no local copy: ${remaining.join(', ')}`,
    );
  }
  return localized;
}

/**
 * How long to wait for buffered largest-contentful-paint entries before
 * reading the series as 0. The audit's probe read them through a buffered
 * observer within this window in 4 of 4 loads, in Chromium 149.
 */
export const LCP_READ_TIMEOUT_MS = 500;

/**
 * Read the page's largest contentful paint. Runs in the page.
 *
 * Chromium does not expose largest-contentful-paint entries through
 * `performance.getEntriesByType`, so that read returns nothing; a buffered
 * `PerformanceObserver` receives the entries recorded so far in its first
 * callback. The value is the last candidate's `startTime`. The function is
 * serialized into the page, so it must not reference anything outside its
 * own body.
 *
 * @param timeoutMs - How long to wait for the buffered entries.
 * @returns The largest contentful paint in ms, or 0 when none was recorded.
 */
export function readLargestContentfulPaint(timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    // Whichever settles the promise first wins; the other's `resolve` and
    // `disconnect` are then no-ops.
    const observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length > 0) {
        observer.disconnect();
        resolve(entries[entries.length - 1].startTime);
      }
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(0);
    }, timeoutMs);
  });
}

/**
 * Known-answer lever: delays every response of the test dapp's own
 * `main.js`, a deferred script that `domContentLoaded` and `pageLoadTime`
 * wait on, by this many ms. Unset or empty, it is 0 and nothing is routed.
 */
export const KNOWN_ANSWER_DAPP_SCRIPT_DELAY =
  'BENCHMARK_KNOWN_ANSWER_DAPP_SCRIPT_DELAY_MS';

/**
 * Set to `1` to route `main.js` exactly as the lever does, with no delay: the
 * comparison arm for a lever run. Routing any URL in a context makes
 * Playwright intercept every request of every page in it and turns the HTTP
 * cache off (`Network.setCacheDisabled` in `crNetworkManager.js`, Playwright
 * 1.59.1), so a lever arm compared with an unrouted arm measures that change
 * as well as the delay. Unset, nothing is routed.
 */
export const DAPP_SCRIPT_ROUTE_CONTROL = 'BENCHMARK_DAPP_SCRIPT_ROUTE_CONTROL';

/**
 * Whether this run routes the dapp's `main.js` through Playwright: when the
 * lever is above 0, or the control arm is on.
 *
 * @returns True when the route is installed.
 */
export function shouldRouteDappScript(): boolean {
  return (
    getKnownAnswerDelayMs(KNOWN_ANSWER_DAPP_SCRIPT_DELAY) > 0 ||
    process.env[DAPP_SCRIPT_ROUTE_CONTROL] === '1'
  );
}

declare global {
  /**
   * We override Performance interface to make sure Typescript allows us to access memory property without
   * any type issues, and to make sure we do not need to typecast when accessing said property which is deprecated and not supported in some browsers
   * since our benchmark runs on Chrome only for now, that is not an issue, since Chrome fully supports the API
   * docs: https://developer.mozilla.org/en-US/docs/Web/API/Performance/memory#browser-compatibility
   */
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Performance {
    memory: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  }
}

/**
 * Main class for conducting page load performance benchmarks using Playwright.
 * Manages browser lifecycle, extension loading, and performance measurement collection.
 */
export class PageLoadBenchmark {
  /** Playwright browser instance for running tests */
  private browser: Browser | undefined;

  /** Browser context for managing pages and sessions */
  private context: BrowserContext | undefined;

  /** Path to the MetaMask extension directory */
  private extensionPath: string;

  /** Collection of all benchmark results from test runs */
  private results: DappPageLoadSample[] = [];

  /** Dapp server process running in background */
  private dappServerProcess: ChildProcess | undefined;

  private readonly userDataDirectory = 'temp-benchmark-user-data';

  /** The test dapp as served: a copy whose stylesheets are local. */
  private readonly dappRootDirectory = 'temp-benchmark-dapp';

  /** Runs below this are warm-up, set by {@link runBenchmark}. */
  private firstMeasuredRun = 0;

  /**
   * Creates a new PageLoadBenchmark instance.
   *
   * @param extensionPath - Path to the MetaMask extension directory to test
   */
  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  /**
   * Initializes the browser environment and loads the MetaMask extension.
   * Builds the extension if needed, launches browser with optimized settings,
   * and waits for the extension to fully load.
   *
   * @throws {Error} If browser or context initialization fails
   */
  async setup() {
    await this.buildExtension();
    await this.createStaticDappServer(await this.prepareDappRoot());

    const userDataDir = path.join(process.cwd(), this.userDataDirectory);
    await fs.mkdir(userDataDir, { recursive: true });

    this.context = await chromium.launchPersistentContext(userDataDir, {
      headless: Boolean(process.env.CI),
      args: [
        `--disable-extensions-except=${this.extensionPath}`,
        `--load-extension=${this.extensionPath}`,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
      ],
      viewport: { width: 1280, height: 720 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const browser = this.context.browser();
    if (!browser) {
      throw new Error('Failed to get browser instance from persistent context');
    }
    this.browser = browser;

    await this.installDappScriptRoute();
    await this.waitForExtensionLoad();
  }

  /**
   * Route the dapp's `main.js` through the known-answer lever when this run
   * asks for it ({@link shouldRouteDappScript}). Otherwise nothing is routed,
   * and the HTTP cache and the request path are as they were.
   */
  private async installDappScriptRoute() {
    if (!shouldRouteDappScript()) {
      return;
    }
    const script = new URL('main.js', `${DAPP_URL}/`).href;
    await this.context?.route(
      (url) => url.href === script,
      withKnownAnswerDelay(KNOWN_ANSWER_DAPP_SCRIPT_DELAY, (route: Route) =>
        route.continue(),
      ),
    );
  }

  /**
   * Copy the test dapp into a working directory and point its off-host
   * stylesheets at the local copies ({@link localizeOffHostStylesheets}).
   *
   * File times are kept from the installed package, and the rewritten
   * `index.html` and the stylesheet copies are given the original
   * `index.html`'s, because the static server sends no cache headers but
   * `Last-Modified`, from which the browser derives how long to reuse a cached
   * response. Fresh times would make it revalidate files it reuses today.
   *
   * @returns The directory to serve.
   */
  private async prepareDappRoot(): Promise<string> {
    const source = path.join(
      process.cwd(),
      'node_modules',
      '@metamask',
      'test-dapp',
      'dist',
    );
    const root = path.join(process.cwd(), this.dappRootDirectory);
    await fs.rm(root, { recursive: true, force: true });
    await fs.cp(source, root, { recursive: true, preserveTimestamps: true });

    const indexPath = path.join(root, 'index.html');
    const { atime, mtime } = await fs.stat(indexPath);
    await fs.writeFile(
      indexPath,
      localizeOffHostStylesheets(await fs.readFile(indexPath, 'utf8')),
    );

    const stylesheetRoot = path.join(root, LOCAL_STYLESHEET_DIRECTORY);
    await fs.mkdir(stylesheetRoot, { recursive: true });
    for (const fileName of Object.values(TEST_DAPP_OFF_HOST_STYLESHEETS)) {
      const target = path.join(stylesheetRoot, fileName);
      await fs.copyFile(
        path.join(__dirname, LOCAL_STYLESHEET_DIRECTORY, fileName),
        target,
      );
      await fs.utimes(target, atime, mtime);
    }
    await fs.utimes(indexPath, atime, mtime);
    return root;
  }

  /**
   * Ensures the MetaMask extension is built and ready for testing.
   * Checks if the extension already exists in the dist directory,
   * and builds it if necessary using the test build configuration.
   *
   * @throws {Error} If the build process fails
   */
  private async buildExtension() {
    // Check if extension is already built
    const distPath = path.join(process.cwd(), 'dist', 'chrome');
    try {
      await fs.access(distPath);
      console.log('Extension already built, using existing build');
    } catch {
      console.log('Building extension...');
      execSync('yarn build:test', { stdio: 'inherit' });
    }
    this.extensionPath = distPath;
  }

  /**
   * Starts the static dapp server in the background: the server `yarn dapp`
   * runs, on the port of {@link DAPP_URL}, serving the given directory.
   *
   * @param rootDirectory - The test dapp to serve, from {@link prepareDappRoot}.
   */
  async createStaticDappServer(rootDirectory: string) {
    try {
      console.log('Creating static dapp server...');

      this.dappServerProcess = spawn(
        process.execPath,
        [
          path.join('development', 'static-server.js'),
          rootDirectory,
          '--port',
          new URL(DAPP_URL).port,
        ],
        {
          stdio: 'pipe', // Capture output but don't block
          detached: false, // Keep attached to parent process for cleanup
          cwd: process.cwd(),
        },
      );

      this.dappServerProcess.stderr?.on('data', (data) => {
        console.error('Dapp server error:', data.toString());
      });

      // Wait for the server to report readiness rather than guessing at a delay.
      // `development/static-server.js` prints this line once it is accepting
      // connections. A timeout rejects instead of resolving, so a server that
      // never binds fails at this step rather than handing a dead port to the
      // measurement and surfacing later as a missing results file.
      return await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Dapp server did not report readiness within ${DAPP_SERVER_READY_TIMEOUT_MS}ms`,
            ),
          );
        }, DAPP_SERVER_READY_TIMEOUT_MS);

        this.dappServerProcess?.stdout?.on('data', (data) => {
          if (data.toString().includes('Running at http://localhost:')) {
            console.log('Static dapp server up!');
            clearTimeout(timer);
            resolve();
          }
        });

        this.dappServerProcess?.on('error', (error) => {
          console.error('Failed to start dapp server:', error);
          clearTimeout(timer);
          reject(error);
        });

        // Logging is unconditional: once the promise has settled a `reject` here
        // is a no-op, so without this a server that dies mid-benchmark would
        // exit silently — which is the class of failure this change exists to
        // stop. The rejection only reaches a caller before readiness.
        this.dappServerProcess?.on('exit', (code) => {
          if (code !== 0) {
            console.error(`Dapp server exited with code ${code}`);
          }
          clearTimeout(timer);
          reject(
            new Error(
              `Dapp server exited with code ${code} before reporting readiness`,
            ),
          );
        });
      });
    } catch (e) {
      console.log('ERROR starting dapp server:', e);
      throw e;
    }
  }

  /**
   * Waits for the MetaMask extension to fully load in the browser.
   * Finds the extension's home page and waits for it to reach a stable state
   * before proceeding with benchmark tests.
   */
  private async waitForExtensionLoad() {
    const pages = await this.context?.pages();
    const extensionPage = pages?.find(
      (page) =>
        page.url().includes('chrome-extension://') &&
        page.url().includes('home.html'),
    );

    if (extensionPage) {
      await extensionPage.waitForLoadState('networkidle');
    }
  }

  /**
   * Measures performance metrics for a single page load.
   * Navigates to the specified URL, waits for the page to fully load,
   * and collects comprehensive performance data including timing and memory usage.
   *
   * @param url - The URL to navigate to and measure
   * @param runNumber - Sequential number identifying this test run
   * @returns Promise resolving to the benchmark result for this page load
   * @throws {Error} If browser context is not initialized or page measurement fails
   */
  async measurePageLoad(
    url: string,
    runNumber: number,
  ): Promise<DappPageLoadSample> {
    const page = await this.context?.newPage();

    if (!page) {
      throw new Error('Browser Context not initialized.');
    }

    await page.goto(url, { waitUntil: 'networkidle' });

    // Wait for page to be fully loaded
    await page.waitForLoadState('domcontentloaded');
    await page.waitForLoadState('networkidle');
    // Network-idle can come before the load event has finished, for example
    // with a route installed (the known-answer lever and its control), and
    // `loadEventEnd` then reads 0. Read the timings only once it is set.
    await page.waitForFunction(() => {
      const [navigation] = performance.getEntriesByType(
        'navigation',
      ) as PerformanceNavigationTiming[];
      return (navigation?.loadEventEnd ?? 0) > 0;
    });

    // Collect performance metrics
    const timeline: Omit<DappPageLoadMetric, 'largestContentfulPaint'> =
      await page.evaluate(() => {
        const navigation = performance.getEntriesByType(
          'navigation',
        )[0] as PerformanceNavigationTiming;
        const paint = performance.getEntriesByType('paint');

        return {
          pageLoadTime: navigation.loadEventEnd - navigation.startTime,
          domContentLoaded:
            navigation.domContentLoadedEventEnd - navigation.startTime,
          firstPaint:
            paint.find((p) => p.name === 'first-paint')?.startTime || 0,
          firstContentfulPaint:
            paint.find((p) => p.name === 'first-contentful-paint')?.startTime ||
            0,
          memoryUsage: performance.memory
            ? {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
              }
            : undefined,
        };
      });
    const metrics: DappPageLoadMetric = {
      ...timeline,
      largestContentfulPaint: await page.evaluate(
        readLargestContentfulPaint,
        LCP_READ_TIMEOUT_MS,
      ),
    };

    const result: DappPageLoadSample = {
      page: url === DAPP_URL ? 'Localhost MetaMask Test Dapp' : url,
      run: runNumber,
      metrics,
      timestamp: new Date().getTime(),
    };

    this.results.push(result);
    await page.close();

    return result;
  }

  /**
   * Executes the complete benchmark test suite across multiple browser loads and page loads.
   * Uses the persistent browser context to simulate real-world conditions,
   * and measures each URL multiple times to gather statistical data.
   *
   * The first browser load of the job is measured and then discarded as
   * warm-up ({@link getFirstMeasuredRun}).
   *
   * @param urls - Array of URLs to test
   * @param browserLoads - Number of browser load iterations (default: {@link DEFAULT_BENCHMARK_BROWSER_LOADS})
   * @param pageLoads - Number of page loads per browser load (default: {@link DEFAULT_BENCHMARK_PAGE_LOADS})
   */
  async runBenchmark(
    urls: string[],
    browserLoads: number = DEFAULT_BENCHMARK_BROWSER_LOADS,
    pageLoads: number = DEFAULT_BENCHMARK_PAGE_LOADS,
  ) {
    this.firstMeasuredRun = getFirstMeasuredRun(browserLoads, pageLoads);
    console.log(
      `Starting benchmark: ${browserLoads} browser loads, ${pageLoads} page loads per browser`,
    );

    for (let browserLoad = 0; browserLoad < browserLoads; browserLoad++) {
      console.log(`Browser load ${browserLoad + 1}/${browserLoads}`);
      await this.waitForExtensionLoad();

      for (const url of urls) {
        for (let pageLoad = 0; pageLoad < pageLoads; pageLoad++) {
          const runNumber = browserLoad * pageLoads + pageLoad;
          console.log(
            `  Measuring ${url} (run ${runNumber + 1}/${browserLoads * pageLoads})`,
          );

          await this.measurePageLoad(url, runNumber);
          /**
           * To make sure page setup & teardown doesn't have unexpected results in the next measurement,
           * we add a small delay between measurements.
           */
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      await this.clearBrowserData();
    }
  }

  /**
   * Calculates comprehensive statistical summaries for all benchmark results.
   * Groups results by page URL and computes mean, percentiles, min/max, and standard deviation
   * for each performance metric across all test runs.
   *
   * @returns Array of statistical summaries, one for each tested page
   */
  calculateStatistics(): DappPageLoadStats[] {
    return aggregateDappPageLoadStatistics(this.results, {
      firstMeasuredRun: this.firstMeasuredRun,
    });
  }

  /**
   * Clear browser data between browser loads to simulate fresh browser state.
   */
  private async clearBrowserData() {
    await this.context?.clearCookies();
    await this.context?.clearPermissions();
  }

  /**
   * Stops the dapp server process if it's running.
   */
  private stopDappServer() {
    if (this.dappServerProcess) {
      console.log('Stopping dapp server...');
      this.dappServerProcess.kill('SIGTERM');
      this.dappServerProcess = undefined;
    }
  }

  /**
   * Cleans up browser resources and closes all connections.
   * Should be called after benchmark testing is complete to free up system resources.
   */
  async cleanup() {
    await this.context?.close();
    await this.browser?.close();
    this.stopDappServer();

    // Clean up temporary user data directory
    const userDataDir = path.join(process.cwd(), this.userDataDirectory);
    try {
      await fs.rm(userDataDir, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up temporary user data directory:', error);
    }

    const dappRoot = path.join(process.cwd(), this.dappRootDirectory);
    try {
      await fs.rm(dappRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn('Failed to clean up the served test dapp copy:', error);
    }
  }
}
