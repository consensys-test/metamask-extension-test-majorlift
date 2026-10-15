/**
 * Benchmark: Confirm Transaction
 * Measures time to confirm a transaction
 */

import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import { createInternalTransaction } from '../../../page-objects/flows/transaction.flow';
import { Driver } from '../../../webdriver/driver';
import { buildLongTaskTimerResults } from '../../utils/long-task-helper';
import {
  finishInPageStep,
  startInPageStep,
} from '../../utils/in-page-step-timer';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
} from '../../../../../shared/constants/benchmarks';
import { runUserActionBenchmark, collectWebVitals } from '../../utils';
import type {
  BenchmarkRunResult,
  LongTaskStepResult,
  TimerResult,
} from '../../utils/types';

export const testTitle = 'benchmark-user-actions-confirm-tx';
export const persona = BENCHMARK_PERSONA.STANDARD;

export async function run(): Promise<BenchmarkRunResult> {
  return runUserActionBenchmark(async () => {
    let loadingTimes: number = 0;
    const steps: LongTaskStepResult[] = [];
    const inPageTimers: TimerResult[] = [];
    let webVitals;

    await withFixtures(
      {
        fixtures: new FixtureBuilderV2().build(),
        disableServerMochaToBackground: true,
        title: testTitle,
      },
      async ({ driver }: { driver: Driver }) => {
        await login(driver);

        // The confirmed transaction is shown on the home page's Activity
        // tab. The home page reopens on the tab it last showed, so the tab is
        // selected here, before the send, and the app returns to it after the
        // Confirm click without the harness clicking anything inside the step.
        await driver.clickElement(
          '[data-testid="account-overview__activity-tab"]',
        );
        await createInternalTransaction({
          driver,
          recipientAddress: '0x2f318C334780961FB129D2a6c30D0763d9a5C970',
          amount: '1',
        });

        // The step holds the Confirm click and the app's response, up to the
        // confirmed transaction in the activity list. The harness waits for
        // the button before the timer starts.
        const confirmButton = { text: 'Confirm', tag: 'button' };
        await driver.findClickableElement(confirmButton);
        const confirmProbe = await startInPageStep(driver, 'confirm_tx', {
          endSelector: '[data-tx-status="confirmed"]',
          startWithin: '[data-testid="confirm-footer-button"]',
        });
        await driver.resetLongTaskMetrics();
        const timestampBeforeAction = new Date();

        await driver.clickElement(confirmButton);
        await driver.wait(async () => {
          const confirmedTxes = await driver.findElements(
            '[data-tx-status="confirmed"]',
          );
          return confirmedTxes.length === 1;
        }, 10000);
        await driver.waitForSelector('[data-tx-status="confirmed"]');
        const timestampAfterAction = new Date();
        loadingTimes =
          timestampAfterAction.getTime() - timestampBeforeAction.getTime();

        const longTaskData = await driver.collectLongTaskMetrics();
        steps.push({
          id: 'confirm_tx',
          duration: loadingTimes,
          longTaskCount: longTaskData?.count ?? 0,
          longTaskTotalDuration: longTaskData?.totalDuration ?? 0,
          longTaskMaxDuration: longTaskData?.maxDuration ?? 0,
          tbt: longTaskData?.tbt ?? 0,
          longTasksObserved: longTaskData?.observed ?? false,
        });
        if (confirmProbe) {
          inPageTimers.push(...(await finishInPageStep(driver, 'confirm_tx')));
        }

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
        ...inPageTimers,
      ],
      webVitals,
    };
  }, BENCHMARK_TYPE.USER_ACTION);
}
