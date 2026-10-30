/**
 * Benchmark: Standard Home Page Load
 * Measures home page load time with standard wallet state
 */

import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import {
  BENCHMARK_PERSONA,
  type BenchmarkResults,
  type WebVitalsMetrics,
} from '../../../../../shared/constants/benchmarks';
import {
  runPageLoadBenchmark,
  collectWebVitals,
  collectGarbageBetweenIterations,
  applyStartupPageSignals,
  installDocumentStartDelay,
  readStartupDelayMs,
  readStartupPageSignals,
  readStartupSettleQuietMs,
  waitForNetworkQuiet,
} from '../../utils';
import type {
  BrowserErrorRecord,
  SettleRecord,
  StartupMeasurePageResult,
} from '../../utils/runner';
import type { Metrics, PageLoadBenchmarkOptions } from '../../utils/types';

async function measurePageStandard(
  pageName: string,
  pageLoads: number,
): Promise<StartupMeasurePageResult> {
  const metrics: Metrics[] = [];
  const webVitalsRuns: WebVitalsMetrics[] = [];
  const title = 'measurePageStandard';
  const persona = BENCHMARK_PERSONA.STANDARD;
  const settleQuietMs = readStartupSettleQuietMs();
  const startupDelayMs = readStartupDelayMs();
  let settle: SettleRecord | undefined;
  let browserErrors: BrowserErrorRecord | undefined;
  await withFixtures(
    {
      fixtures: new FixtureBuilderV2().build(),
      disableServerMochaToBackground: true,
      title,
      isBenchmark: true,
    },
    async ({
      driver,
      getNetworkReport,
      clearNetworkReport,
      getBrowserErrors,
    }) => {
      await login(driver, { validateBalance: false });

      if (settleQuietMs > 0) {
        settle = await waitForNetworkQuiet(getNetworkReport, settleQuietMs);
        console.log('Startup settle step:', settle);
      }
      await installDocumentStartDelay(driver, startupDelayMs);

      for (let i = 0; i < pageLoads; i++) {
        clearNetworkReport();
        await driver.navigate(pageName);
        // The count's window ends when the navigation returns, which waits
        // for `.controller-loaded`, set right after `uiStartup` ends; not after
        // the fixed sleep below.
        const { numNetworkReqs } = getNetworkReport();
        await driver.delay(1000);

        const metricsThisLoad = applyStartupPageSignals(
          await driver.collectMetrics(),
          await readStartupPageSignals(driver),
        );
        metricsThisLoad.numNetworkReqs = numNetworkReqs;
        metrics.push(metricsThisLoad);

        try {
          webVitalsRuns.push(await collectWebVitals(driver));
        } catch (error) {
          console.error(`Error collecting web vitals for ${pageName}:`, error);
        }

        if (i < pageLoads - 1) {
          await collectGarbageBetweenIterations(driver);
        }
      }

      browserErrors = getBrowserErrors();
    },
  );
  return {
    metrics,
    title,
    persona,
    webVitalsRuns,
    browserLoad: {
      ...(browserErrors && { browserErrors }),
      ...(settle && { settle }),
    },
  };
}

export async function run(
  options: PageLoadBenchmarkOptions,
): Promise<BenchmarkResults> {
  return runPageLoadBenchmark(measurePageStandard, options);
}
