import type { MockedEndpoint } from 'mockttp';
import { TraceName } from '../../../../shared/lib/trace';
import { getCleanAppState } from '../../helpers';
import { waitUntilAccountTreeSyncIdle } from '../../page-objects/flows/add-account.flow';
import type { Driver } from '../../webdriver/driver';
import {
  readSentryTransactions,
  sentryTimerResult,
  type SentryTransaction,
} from './sentry-transactions';
import type { TimerResult } from './types';

/**
 * Harness steps shared by the onboarding and import journeys: loading the home
 * page after side-panel onboarding, waits that set the app's state before a
 * step's trigger, and the read of the app's `UI Startup` span for the home
 * page the harness loads.
 *
 * Each wait runs outside every timer, and only when its switch is set to `1`.
 * Unset, a flow runs exactly as it did before the switch existed.
 */

/**
 * Before each step whose start state is in question, wait for two
 * consecutive idle periods of the page: see {@link waitForPageIdleBeforeStep}.
 */
export const PAGE_IDLE_BEFORE_STEP = 'BENCHMARK_PAGE_IDLE_BEFORE_STEP';

/**
 * Before each account-list step, wait until account syncing reports idle:
 * see {@link waitForAccountSyncIdleBeforeStep}.
 */
export const ACCOUNT_SYNC_IDLE_BEFORE_STEP =
  'BENCHMARK_ACCOUNT_SYNC_IDLE_BEFORE_STEP';

/**
 * In the new-wallet flow, sample every trace and read the app's `UI Startup`
 * span for the home page the harness loads on Chrome. The onboarding import
 * flow already samples every trace, so it reads that span without a switch.
 */
export const NEW_WALLET_TRACES = 'BENCHMARK_NEW_WALLET_TRACES';

/**
 * How long to wait for a `UI Startup` transaction, and how often to read the
 * mocked Sentry endpoint meanwhile: the defaults of
 * `waitForSentryTransactions` in `sentry-transactions.ts`.
 */
const SENTRY_WAIT_MS = 10000;
const SENTRY_POLL_MS = 250;

/**
 * A span starts at the document's time origin when the app passes
 * `performance.timeOrigin` as its start, as `UI Startup` does
 * (`app/scripts/ui.ts`). The envelope carries that value in seconds, so after
 * the round trip the two differ only by floating-point error, far below this.
 */
const TIME_ORIGIN_TOLERANCE_MS = 1;

/**
 * After the onboarding Done click, load the home page into the test window
 * where the build opens it in the side panel instead. This is the navigation
 * in `handleSidepanelPostOnboarding` (`page-objects/flows/onboarding.flow.ts`)
 * without its closing wait for the header, so a step timer opened when this
 * returns covers the header and the rest of the home page.
 *
 * It waits for `completedOnboarding`, then navigates to `home.html`. The
 * navigation returns once the document has loaded, so the load itself stays
 * before the step.
 *
 * @param driver - The WebDriver instance.
 * @returns Whether it loaded the home page; only Chrome has the side panel.
 */
export async function loadHomeAfterSidepanelOnboarding(
  driver: Driver,
): Promise<boolean> {
  // The same condition `handleSidepanelPostOnboarding` uses.
  if (process.env.SELENIUM_BROWSER !== 'chrome') {
    return false;
  }

  await driver.waitUntil(
    async () => {
      const uiState = await getCleanAppState(driver);
      return Boolean(uiState?.metamask?.completedOnboarding);
    },
    { timeout: 30000, interval: 500 },
  );
  await driver.driver.get(`${driver.extensionUrl}/home.html`);
  return true;
}

/**
 * Call `done` once the page has had two consecutive idle periods: the first
 * idle callback requests the second, which the browser runs no earlier than
 * the next idle period. Runs in the page, through `executeAsyncScript`.
 *
 * `Driver.executeAsyncScript(fn)` hands `fn` the array of extra arguments and
 * then the callback that ends the script, so the callback is the second
 * parameter. The function is serialized into the page, so it must not
 * reference anything outside its own body; `requestIdleCallback` is on every
 * build's LavaMoat scuttling exception list.
 *
 * @param _args - The extra arguments, none here.
 * @param done - Ends the script.
 */
export function resolveAfterTwoIdlePeriods(
  _args: unknown,
  done: (result: null) => void,
): void {
  requestIdleCallback(() => {
    requestIdleCallback(() => done(null));
  });
}

/**
 * When `BENCHMARK_PAGE_IDLE_BEFORE_STEP=1`, wait until the page has had two
 * consecutive idle periods. Call it before the step's probe is installed and
 * before its trigger, so the wait stays outside both of the step's timers.
 *
 * A page that never goes idle ends the wait at WebDriver's script timeout, and
 * the error fails the iteration: the step would otherwise start in the state
 * the switch exists to rule out.
 *
 * @param driver - The WebDriver instance.
 */
export async function waitForPageIdleBeforeStep(driver: Driver): Promise<void> {
  if (process.env[PAGE_IDLE_BEFORE_STEP] !== '1') {
    return;
  }
  await driver.executeAsyncScript(resolveAfterTwoIdlePeriods);
}

/**
 * When `BENCHMARK_ACCOUNT_SYNC_IDLE_BEFORE_STEP=1`, wait until the app's state
 * reports `isAccountTreeSyncingInProgress === false`, the flag behind the
 * account list's "Syncing..." label. Call it before the step's probe is
 * installed and before its trigger, so the wait stays outside both of the
 * step's timers.
 *
 * @param driver - The WebDriver instance.
 */
export async function waitForAccountSyncIdleBeforeStep(
  driver: Driver,
): Promise<void> {
  if (process.env[ACCOUNT_SYNC_IDLE_BEFORE_STEP] !== '1') {
    return;
  }
  await waitUntilAccountTreeSyncIdle(driver);
}

/**
 * Read the current document's time origin. Runs in the page; `performance` is
 * on every build's LavaMoat scuttling exception list.
 *
 * @returns `performance.timeOrigin`, in milliseconds since the epoch.
 */
export function readDocumentTimeOrigin(): number {
  return performance.timeOrigin;
}

/**
 * Keep the transactions of one trace that started at a given time origin.
 *
 * @param transactions - Transactions read by `readSentryTransactions`.
 * @param name - The trace to keep.
 * @param timeOriginMs - The document's `performance.timeOrigin`.
 * @returns The matching transactions, in their original order.
 */
export function transactionsStartingAt(
  transactions: SentryTransaction[],
  name: TraceName,
  timeOriginMs: number,
): SentryTransaction[] {
  return transactions.filter(
    (transaction) =>
      transaction.name === name &&
      Math.abs(
        transaction.endTimestamp * 1000 - transaction.durationMs - timeOriginMs,
      ) <= TIME_ORIGIN_TOLERANCE_MS,
  );
}

/**
 * Report the app's `UI Startup` span for the document now in the test window,
 * under `id`. Call it while that window still holds the home page the harness
 * loaded, after every timer of the flow.
 *
 * The span starts at the document's time origin, which for this document is
 * the start of the harness's navigation, and ends once the UI has launched
 * (`app/scripts/ui.ts`). Other documents send their own `UI Startup`, the side
 * panel's among them, so the transaction is matched on this document's
 * `performance.timeOrigin` rather than taken as the last one sent.
 *
 * Absent, never zero, and never thrown: when the time origin cannot be read,
 * when no transaction or more than one started at it, or when the span ended
 * unsuccessfully, this logs why and returns nothing.
 *
 * @param driver - The WebDriver instance.
 * @param endpoints - The mocked endpoints for this benchmark run.
 * @param id - The benchmark metric id to report it under.
 * @returns The timer, or an empty array.
 */
export async function readCurrentDocumentUiStartup(
  driver: Driver,
  endpoints: MockedEndpoint[],
  id: string,
): Promise<TimerResult[]> {
  const absent = (reason: string): TimerResult[] => {
    console.log(`[benchmark] ${id} absent: ${reason}`);
    return [];
  };

  try {
    const timeOriginMs = (await driver.executeScript(
      readDocumentTimeOrigin,
    )) as unknown;
    if (typeof timeOriginMs !== 'number') {
      return absent('the document did not report a time origin');
    }

    let matching: SentryTransaction[] = [];
    for (let waited = 0; ; waited += SENTRY_POLL_MS) {
      matching = transactionsStartingAt(
        await readSentryTransactions(endpoints),
        TraceName.UIStartup,
        timeOriginMs,
      );
      if (matching.length > 0 || waited >= SENTRY_WAIT_MS) {
        break;
      }
      await driver.delay(SENTRY_POLL_MS);
    }

    if (matching.length === 0) {
      return absent(
        `no "${TraceName.UIStartup}" transaction started at this document's time origin within ${SENTRY_WAIT_MS} ms`,
      );
    }
    if (matching.length > 1) {
      return absent(
        `${matching.length} "${TraceName.UIStartup}" transactions started at this document's time origin`,
      );
    }
    const timer = sentryTimerResult(matching, TraceName.UIStartup, id);
    console.log(`[benchmark] ${id}: ${timer.value.toFixed(1)} ms`);
    return [timer];
  } catch (error) {
    return absent(error instanceof Error ? error.message : String(error));
  }
}
