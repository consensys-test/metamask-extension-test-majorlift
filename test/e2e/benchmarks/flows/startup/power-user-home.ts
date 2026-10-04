/**
 * Benchmark: Power User Home Page Load
 * Measures home page load time with power user state (30 accounts, transactions, etc.)
 */

import { Mockttp } from 'mockttp';
import { generateWalletState } from '../../../../../app/scripts/fixtures/generate-wallet-state';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import AccountListPage from '../../../page-objects/pages/accounts/list-page';
import HeaderNavbar from '../../../page-objects/pages/home/header-navbar';
import { userStorageHostMock } from '../../mocks/performance-mocks';
import { mockNotificationServices } from '../../../tests/notifications/mocks';
import {
  BENCHMARK_PERSONA,
  type BenchmarkResults,
  type WebVitalsMetrics,
} from '../../../../../shared/constants/benchmarks';
import {
  WITH_STATE_POWER_USER,
  POWER_USER_NUM_BROWSER_LOADS,
} from '../../utils/constants';
import {
  runPageLoadBenchmark,
  collectWebVitals,
  collectGarbageBetweenIterations,
} from '../../utils';
import type {
  Metrics,
  PageLoadBenchmarkOptions,
  MeasurePageResult,
} from '../../utils/types';

async function measurePagePowerUser(
  pageName: string,
  pageLoads: number,
): Promise<MeasurePageResult> {
  const metrics: Metrics[] = [];
  const webVitalsRuns: WebVitalsMetrics[] = [];
  const title = 'measurePagePowerUser';
  const persona = BENCHMARK_PERSONA.POWER_USER;
  await withFixtures(
    {
      title,
      isBenchmark: true,
      fixtures: (
        await generateWalletState(WITH_STATE_POWER_USER, true)
      ).build(),
      manifestFlags: {
        testing: {
          infuraProjectId: process.env.INFURA_PROJECT_ID,
        },
      },
      useMockingPassThrough: true,
      disableServerMochaToBackground: true,
      extendedTimeoutMultiplier: 3,
      // Caught and logged by app code during home-page load, 61 ms before
      // `.controller-loaded` appears, on all 21 measured loads of a 29-run
      // window -- the metrics are unaffected. Left un-ignored it accumulates
      // in `driver.errors`, so `withFixtures` throws AFTER the body succeeds
      // and its recovery path waits for `.controller-loaded` on the MV3
      // background page, which can never set it. That is what exhausts the
      // retries. The bundle offset in the logged text is the stack's tail,
      // so it names the entry point rather than the thrower; the throwing
      // frame is still unidentified and is tracked separately.
      ignoredConsoleErrors: [
        "Cannot read properties of undefined (reading 'mutations')",
      ],
      testSpecificMock: async (server: Mockttp) => {
        await mockNotificationServices(server);
        await userStorageHostMock(server);
      },
    },
    async ({ driver, getNetworkReport, clearNetworkReport }) => {
      await login(driver, { validateBalance: false });

      for (let i = 0; i < pageLoads; i++) {
        clearNetworkReport();
        await driver.navigate(pageName);

        // Confirm the number of accounts in the account list
        await new HeaderNavbar(driver).openAccountMenu();
        const accountListPage = new AccountListPage(driver);

        // Wait for Account Sync to finish.
        await accountListPage.waitUntilSyncingIsCompleted();
        await accountListPage.checkNumberOfAvailableAccounts(
          WITH_STATE_POWER_USER.withAccounts,
        );
        await accountListPage.checkAccountDisplayedInAccountList(
          `Account ${WITH_STATE_POWER_USER.withAccounts}`,
        );

        await driver.delay(1000);

        const metricsThisLoad = await driver.collectMetrics();
        metricsThisLoad.numNetworkReqs = getNetworkReport().numNetworkReqs;
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
    },
  );
  return { metrics, title, persona, webVitalsRuns };
}

export async function run(
  options: PageLoadBenchmarkOptions,
): Promise<BenchmarkResults> {
  return runPageLoadBenchmark(measurePagePowerUser, {
    ...options,
    browserLoads: options.browserLoads ?? POWER_USER_NUM_BROWSER_LOADS,
  });
}
