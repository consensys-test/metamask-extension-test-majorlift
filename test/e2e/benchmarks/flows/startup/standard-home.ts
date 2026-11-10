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
  applyStartupPageSignals,
  installDocumentStartDelay,
  installStartUiSyncBlock,
  isStartupPostHeroLongTasksOn,
  readStartupDelayMs,
  readStartupLeverMarks,
  readStartupPageSignals,
  readStartupSettleQuietMs,
  readStartupSyncBlockMs,
  selectPostHeroLongTasks,
  waitForNetworkQuiet,
} from '../../utils';
import type {
  BrowserErrorRecord,
  PostHeroLongTasks,
  SettleRecord,
  StartupLeverMarks,
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
  const startupSyncBlockMs = readStartupSyncBlockMs();
  const startupLeverSet = startupDelayMs > 0 || startupSyncBlockMs > 0;
  const leverMarks: StartupLeverMarks[] = [];
  const postHeroLongTasksOn = isStartupPostHeroLongTasksOn();
  const postHeroLongTasks: PostHeroLongTasks[] = [];
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
      await installStartUiSyncBlock(driver, startupSyncBlockMs);

      for (let i = 0; i < pageLoads; i++) {
        clearNetworkReport();
        await driver.navigate(pageName);
        // The count's window ends when the navigation returns, which waits
        // for `.controller-loaded`, set right after `uiStartup` ends; not after
        // the fixed sleep below.
        const { numNetworkReqs } = getNetworkReport();
        await driver.delay(1000);

        const collected = await driver.collectMetrics();
        const signals = await readStartupPageSignals(driver);
        const metricsThisLoad = applyStartupPageSignals(collected, signals);
        metricsThisLoad.numNetworkReqs = numNetworkReqs;
        metrics.push(metricsThisLoad);

        try {
          webVitalsRuns.push(await collectWebVitals(driver));
        } catch (error) {
          console.error(`Error collecting web vitals for ${pageName}:`, error);
        }

        // The long tasks after the hero mark, taken from the signals just read:
        // no further read of the page, so no series changes.
        if (postHeroLongTasksOn) {
          postHeroLongTasks.push(
            selectPostHeroLongTasks(signals, collected['UI Startup']),
          );
        }

        // The lever's own marks, read after everything the series come from,
        // and only when a startup lever is set.
        if (startupLeverSet) {
          leverMarks.push(await readStartupLeverMarks(driver));
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
    ...(startupLeverSet && { leverMarks }),
    ...(postHeroLongTasksOn && { postHeroLongTasks }),
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
