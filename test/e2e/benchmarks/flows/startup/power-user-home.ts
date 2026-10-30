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

async function measurePagePowerUser(
  pageName: string,
  pageLoads: number,
): Promise<StartupMeasurePageResult> {
  const metrics: Metrics[] = [];
  const webVitalsRuns: WebVitalsMetrics[] = [];
  const title = 'measurePagePowerUser';
  const persona = BENCHMARK_PERSONA.POWER_USER;
  const settleQuietMs = readStartupSettleQuietMs();
  const startupDelayMs = readStartupDelayMs();
  let settle: SettleRecord | undefined;
  let browserErrors: BrowserErrorRecord | undefined;
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
      // The default mocked setup (`setupMocking`), as every other power-user
      // benchmark uses, rather than passing unmocked requests through to live
      // servers: live responses made the state each run started from differ,
      // and a live `getSubscriptions` failure was one trigger of the lost
      // chrome sessions (extension#45945).
      useMockingPassThrough: false,
      disableServerMochaToBackground: true,
      extendedTimeoutMultiplier: 3,
      testSpecificMock: async (server: Mockttp) => {
        await mockNotificationServices(server);
        await userStorageHostMock(server);
      },
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
        // the account-list check and the fixed sleep below.
        const { numNetworkReqs } = getNetworkReport();

        // Confirm the number of accounts in the account list. A correctness
        // check: no series ends after it.
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
  return runPageLoadBenchmark(measurePagePowerUser, {
    ...options,
    browserLoads: options.browserLoads ?? POWER_USER_NUM_BROWSER_LOADS,
  });
}
