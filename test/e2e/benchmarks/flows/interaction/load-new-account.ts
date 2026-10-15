/**
 * Benchmark: Load New Account
 * Measures time to create and load a new account
 */

import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import HeaderNavbar from '../../../page-objects/pages/home/header-navbar';
import AccountListPage from '../../../page-objects/pages/accounts/list-page';
import { Driver } from '../../../webdriver/driver';
import { buildLongTaskTimerResults } from '../../utils/long-task-helper';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
} from '../../../../../shared/constants/benchmarks';
import { runUserActionBenchmark, collectWebVitals } from '../../utils';
import type { BenchmarkRunResult, LongTaskStepResult } from '../../utils/types';

export const testTitle = 'benchmark-user-actions-load-new-account';
export const persona = BENCHMARK_PERSONA.STANDARD;

export async function run(): Promise<BenchmarkRunResult> {
  return runUserActionBenchmark(async () => {
    let loadingTimes: number = 0;
    const steps: LongTaskStepResult[] = [];
    let webVitals;

    await withFixtures(
      {
        fixtures: new FixtureBuilderV2().build(),
        disableServerMochaToBackground: true,
        localNodeOptions: {
          accounts: 1,
        },
        title: testTitle,
      },
      async ({ driver }: { driver: Driver }) => {
        await login(driver);

        const headerNavbar = new HeaderNavbar(driver);
        await headerNavbar.openAccountMenu();
        const accountListPage = new AccountListPage(driver);
        await accountListPage.checkPageIsLoaded();

        // No in-page timer for this step (see `in-page-step-timer.ts`): the
        // step timer ends at the Add account click and nothing in this flow
        // waits for the new account, so ending an in-page timer there needs a
        // wait the flow does not have. Before `collectWebVitals` it would
        // widen the window the vitals cover; after it, the vitals' own probe
        // click would land inside the region whenever the account is slow.
        await driver.resetLongTaskMetrics();
        const timestampBeforeAction = new Date();
        await accountListPage.addMultichainAccount();
        const timestampAfterAction = new Date();
        loadingTimes =
          timestampAfterAction.getTime() - timestampBeforeAction.getTime();

        const longTaskData = await driver.collectLongTaskMetrics();
        steps.push({
          id: 'load_new_account',
          duration: loadingTimes,
          longTaskCount: longTaskData?.count ?? 0,
          longTaskTotalDuration: longTaskData?.totalDuration ?? 0,
          longTaskMaxDuration: longTaskData?.maxDuration ?? 0,
          tbt: longTaskData?.tbt ?? 0,
          longTasksObserved: longTaskData?.observed ?? false,
        });

        try {
          webVitals = await collectWebVitals(driver);
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }
      },
    );

    return {
      timers: [
        ...steps.map((s) => ({ id: s.id, value: s.duration })),
        ...buildLongTaskTimerResults(steps),
      ],
      webVitals,
    };
  }, BENCHMARK_TYPE.USER_ACTION);
}
