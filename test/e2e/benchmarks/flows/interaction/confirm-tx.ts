/**
 * Benchmark: Confirm Transaction
 * Measures time to confirm a transaction
 */

import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import { createInternalTransaction } from '../../../page-objects/flows/transaction.flow';
import { Driver } from '../../../webdriver/driver';
import {
  buildLongTaskTimerResults,
  legacyStepTimerId,
} from '../../utils/long-task-helper';
import {
  finishInPageStep,
  startInPageStep,
} from '../../utils/in-page-step-timer';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
} from '../../../../../shared/constants/benchmarks';
import type {
  InPageProbeReading,
  InPageStepReading,
} from '../../utils/in-page-step-timer';
import { runUserActionBenchmark, collectWebVitals } from '../../utils';
import type {
  BenchmarkRunResult,
  LongTaskStepResult,
  TimerResult,
} from '../../utils/types';

export const testTitle = 'benchmark-user-actions-confirm-tx';
export const persona = BENCHMARK_PERSONA.STANDARD;

/**
 * Wait for the app's state to go quiet before the Confirm click, outside both
 * timers: when set to `1`, the flow waits {@link CONFIRM_SETTLE_MS} after the
 * Confirm button is clickable and before the in-page probe is installed. Unset,
 * or any other value, it does not wait, and the flow runs as it did without
 * this switch.
 *
 * The confirmation page writes to the app's state as it mounts, and those
 * writes reach the UI through the background's debounced state push (200 ms
 * trailing, `maxWait` 1,000 ms; `sendUpdate` in
 * `app/scripts/metamask-controller.js`). A push still pending when the button
 * becomes clickable goes out during a known-answer hold that outlasts its due
 * time, and the UI applies it right after the click, ahead of the approval's
 * own state. The wait lets it out before the probe starts.
 *
 * It changes the app's state at the start of the timed interval, so a series
 * measured with it is a new definition and is not pooled with one measured
 * without it.
 */
export const CONFIRM_SETTLE_BEFORE_TRIGGER =
  'BENCHMARK_CONFIRM_SETTLE_BEFORE_TRIGGER';

/**
 * How long the settle waits, in ms: the debounce's `maxWait` of 1,000 ms plus
 * one render. A write made before the button was clickable is flushed and
 * applied within it. A state change that starts during the wait is not
 * covered.
 */
export const CONFIRM_SETTLE_MS = 1200;

/**
 * A long task that starts less than this many ms after the hold's end is
 * flagged in the long-task line. Where no hold ran, the hold's end is the
 * trigger.
 */
const FLAGGED_LONG_TASK_WINDOW_MS = 10;

/** One of the app's long tasks, on the page's `performance.now()` clock. */
type ConfirmLongTask = { startTime: number; duration: number };

/** The parts of the app's long-task metrics the long-task line reads. */
type ConfirmLongTaskData = {
  tasks: readonly ConfirmLongTask[];
  count: number;
  observed: boolean;
};

/**
 * Describe the step's long tasks on one line, for the job log: each task's
 * start from the probe's start, with its duration, and a flag on a task that
 * starts less than {@link FLAGGED_LONG_TASK_WINDOW_MS} after the hold's end.
 * Both clocks are the page's `performance.now()`, so the subtraction needs no
 * offset.
 *
 * The click is the event the app handles, and the probe does not record its
 * time: its reading has the trigger's `pointerdown` and the length of the hold
 * that followed. The click comes after the hold's end, so the hold's end is
 * the anchor, and a task that starts after the hold's end and before the click
 * is flagged along with those after it.
 *
 * Absent, never zero: with no start to measure from, or no observed long-task
 * data, the line says so.
 *
 * @param longTaskData - What `driver.collectLongTaskMetrics` returned.
 * @param reading - The probe's reading, or null when it could not be read.
 * @returns The line to log.
 */
export function describeConfirmLongTasks(
  longTaskData: ConfirmLongTaskData | null,
  reading: InPageProbeReading | null,
): string {
  const label = '[benchmark] confirm_tx long tasks';
  if (reading === null || reading.start === null) {
    return `${label} absent: the probe has no start to measure from`;
  }
  if (!longTaskData?.observed) {
    return `${label} absent: the app reported no observed long-task data`;
  }

  const { start, heldMs } = reading;
  const entry = ({ startTime, duration }: ConfirmLongTask): string => {
    const fromStart = startTime - start;
    return `${fromStart < 0 ? '' : '+'}${fromStart.toFixed(1)} ms for ${duration.toFixed(1)} ms`;
  };
  const listed =
    longTaskData.tasks.length > 0
      ? longTaskData.tasks.map(entry).join('; ')
      : 'none';
  const truncated =
    longTaskData.count > longTaskData.tasks.length
      ? ` (listed ${longTaskData.tasks.length} of ${longTaskData.count})`
      : '';
  const anchor = heldMs > 0 ? "the hold's end" : 'the trigger';
  const flagged = longTaskData.tasks
    .filter((task) => {
      const afterHold = task.startTime - start - heldMs;
      return afterHold >= 0 && afterHold < FLAGGED_LONG_TASK_WINDOW_MS;
    })
    .map(
      (task) =>
        `${entry(task)} starts ${(task.startTime - start - heldMs).toFixed(1)} ms after ${anchor}, within ${FLAGGED_LONG_TASK_WINDOW_MS} ms`,
    );

  return `${label} (each: start from the probe's start for its duration): ${listed}${truncated}${
    flagged.length > 0 ? `. FLAGGED: ${flagged.join('; ')}` : ''
  }`;
}

/**
 * A pending row in the activity list. `ActivityRowLayout` puts the row's
 * status in `data-tx-status`, and a local transaction reads `pending` from
 * approval until its receipt: `getLocalTransactionStatus` in
 * `@metamask/client-utils` maps unapproved, approved, signed and submitted to
 * it. It reads `confirmed` once the receipt is in.
 */
const PENDING_ACTIVITY_ROW =
  '[data-testid="activity-list-item"][data-tx-status="pending"]';

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

        // The step holds the Confirm click and the app's response. The
        // harness waits for the button before either timer starts. The
        // in-page timer ends at the transaction's first row in the activity
        // list, while it is still pending. The confirmed row waits for the
        // transaction controller's first receipt check, which the served
        // `confirmations_transactions` flag puts 3000 ms after submit, a
        // constant wait that no change to the extension's performance moves.
        // A pending row already in the DOM at the click would make the in-page
        // value absent, not wrong. The step timer, on the harness clock, still
        // runs to the confirmed row.
        const confirmButton = { text: 'Confirm', tag: 'button' };
        await driver.findClickableElement(confirmButton);
        const settled = process.env[CONFIRM_SETTLE_BEFORE_TRIGGER] === '1';
        if (settled) {
          await driver.delay(CONFIRM_SETTLE_MS);
        }
        const confirmProbe = await startInPageStep(driver, 'confirm_tx', {
          endSelector: PENDING_ACTIVITY_ROW,
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
        const confirmReadings: InPageStepReading[] = [];
        if (confirmProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(
              driver,
              'confirm_tx',
              (stepReading) => confirmReadings.push(stepReading),
              settled
                ? [`settled ${CONFIRM_SETTLE_MS} ms before the trigger`]
                : [],
            )),
          );
        }
        console.log(
          describeConfirmLongTasks(
            longTaskData,
            confirmReadings[0]?.reading ?? null,
          ),
        );

        try {
          // `fcp` is the document's first contentful paint, which is the
          // login page's, not this step's, so this flow does not report it.
          webVitals = {
            ...(await collectWebVitals(driver)),
            fcp: null,
            fcpRating: null,
          };
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }
      },
    );

    return {
      timers: [
        ...steps.map((s) => ({
          id: legacyStepTimerId(s.id),
          value: s.duration,
        })),
        ...buildLongTaskTimerResults(steps),
        ...inPageTimers,
      ],
      webVitals,
    };
  }, BENCHMARK_TYPE.USER_ACTION);
}
