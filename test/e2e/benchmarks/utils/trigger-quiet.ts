import type { Mockttp } from 'mockttp';
import type { Driver } from '../../webdriver/driver';
import { FailIterationError } from './in-page-step-timer';

/**
 * A wait before a step's trigger until the app has finished the work it was
 * doing, so the trigger does not find it busy. The wait runs outside the
 * timed interval. It has three parts, each waiting on a different place that
 * work can be, and runs those it is given in this order:
 *
 * - background: a no-op runtime message, one in flight at a time, is
 * answered within `answerMs` over at least `windowMs`;
 * - mock: the flow's mock server has received no request for `quietMs` and
 * has none awaiting an answer;
 * - page: when asked, a heartbeat, a page timer that runs for `windowMs` with
 * no gap over `stallMs`; then `idlePeriods` consecutive idle periods.
 *
 * The page goes last, so its idle periods come after the work the other two
 * parts let land. Each part has its own cap. A part that reaches its cap, a
 * background message that is rejected, or a part that cannot be read, logs
 * which part and why and throws {@link TriggerQuietError}, which fails the
 * iteration: the step would otherwise start in the state the wait exists to
 * rule out. As a step's `readBeforeTrigger`, it is the one kind of error that
 * hook does not catch (`measureStepInPage`).
 *
 * Each part's thresholds are set at its call site, and each call site sits
 * behind its own switch below, off unless set to `1`. Unset, a flow runs
 * exactly as it did before the switch existed. What each part returns goes on
 * the step's readings line: the time it waited and its last reading, which
 * show that the wait ran.
 */

/**
 * At login, between typing the password and clicking Unlock, move the pointer
 * onto the Unlock button and hold it there: see {@link movePointerOnto}.
 */
export const LOGIN_POINTER_BEFORE_TRIGGER =
  'BENCHMARK_LOGIN_POINTER_BEFORE_TRIGGER';

/**
 * At login, between typing the password and clicking Unlock, and after the
 * pointer move when that is on, run the page part.
 */
export const LOGIN_PAGE_IDLE_BEFORE_TRIGGER =
  'BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER';

/**
 * At login, between typing the password and clicking Unlock, run the
 * background part, before the page part when that is on.
 */
export const LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER =
  'BENCHMARK_LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER';

/**
 * Before the send flow's review step, after the amount is typed and before the
 * step's probe is installed, run the mock part.
 */
export const REVIEW_MOCK_QUIET_BEFORE_STEP =
  'BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP';

/**
 * Immediately before the swap flow's swap-page click, after the step's probe
 * is installed, run the mock part and then the page part.
 */
export const SWAP_QUIET_BEFORE_TRIGGER = 'BENCHMARK_SWAP_QUIET_BEFORE_TRIGGER';

/** How often the mock part reads the mock server's traffic. */
const MOCK_POLL_MS = 20;

/** The heartbeat's timer delay; the browser may run it later. */
const HEARTBEAT_TICK_MS = 2;

/** How long the background part waits after an answer before the next message. */
const BACKGROUND_PAUSE_MS = 2;

/** How often the background part checks its condition. */
const BACKGROUND_CHECK_MS = 10;

/**
 * The message the background part sends. No listener acts on its type: the
 * test build's own listener answers only `STOP_PERSISTENCE`
 * (`app/scripts/background.ts:1269-1281`).
 */
const BACKGROUND_MESSAGE = { type: 'BENCHMARK_TRIGGER_QUIET_PING' };

/**
 * What the browser reports when every listener has run and none answered,
 * which is how a no-op message is answered. Any other report, such as no
 * receiving end at all, means the reply did not come from the extension's
 * listeners, and the part fails rather than pass on it.
 */
const PORT_CLOSED_WITHOUT_ANSWER = 'message port closed';

/**
 * The flow's mock server's traffic, as its `request`, `response` and `abort`
 * events report it from {@link trackMockTraffic} on.
 */
export type MockTraffic = {
  /** Requests received. */
  received: number;
  /** Of those, how many were answered. */
  answered: number;
  /** Of those, how many were aborted before an answer. */
  aborted: number;
  /** `Date.now()` at the latest request, or when tracking began. */
  lastReceivedAt: number;
  /** Requests received and not yet answered or aborted, by id. */
  awaiting: Set<string>;
};

export type BackgroundPart = {
  /** How long every message must have been answered within `answerMs`. */
  windowMs: number;
  /** The slowest answer that still counts as prompt. */
  answerMs: number;
  /** How long the part waits before it fails the iteration. */
  capMs: number;
};

export type MockPart = {
  /** The traffic, tracked from before the work this part waits out. */
  traffic: MockTraffic;
  /** How long the mock server must have received nothing. */
  quietMs: number;
  /** How long the part waits before it fails the iteration. */
  capMs: number;
};

export type PagePart = {
  /** Consecutive idle periods to wait for. */
  idlePeriods: number;
  /** A heartbeat to wait for before the idle periods, or none. */
  heartbeat: { windowMs: number; stallMs: number } | null;
  /** How long the part waits before it fails the iteration. */
  capMs: number;
};

/** The parts to run; a part left out does not run. */
export type TriggerQuietParts = {
  background?: BackgroundPart;
  mock?: MockPart;
  page?: PagePart;
};

/**
 * Thrown when a part reaches its cap or cannot be read. It fails the
 * iteration, including from a step's `readBeforeTrigger`.
 */
export class TriggerQuietError extends FailIterationError {}

/**
 * Start counting the mock server's traffic. Call it before the work the mock
 * part is to wait out, so a request already awaiting its answer is counted.
 * mockttp has no way to remove these listeners; they end with the mock server.
 *
 * @param mockServer - The flow's mock server.
 * @returns The traffic, updated as the events arrive.
 */
export async function trackMockTraffic(
  mockServer: Pick<Mockttp, 'on'>,
): Promise<MockTraffic> {
  const traffic: MockTraffic = {
    received: 0,
    answered: 0,
    aborted: 0,
    lastReceivedAt: Date.now(),
    awaiting: new Set(),
  };
  await mockServer.on('request', (request) => {
    traffic.received += 1;
    traffic.lastReceivedAt = Date.now();
    traffic.awaiting.add(request.id);
  });
  await mockServer.on('response', (response) => {
    if (traffic.awaiting.delete(response.id)) {
      traffic.answered += 1;
    }
  });
  await mockServer.on('abort', (request) => {
    if (traffic.awaiting.delete(request.id)) {
      traffic.aborted += 1;
    }
  });
  return traffic;
}

/** What {@link waitForPageQuietInPage} reports. */
export type PageQuietReading = {
  outcome: 'quiet' | 'capped';
  waitedMs: number;
  /** When the heartbeat held, in ms from the start; null if it did not. */
  heartbeatHeldAtMs: number | null;
  /** The largest gap between heartbeat timers; null without a heartbeat. */
  largestGapMs: number | null;
  /** Idle periods seen. */
  idlePeriods: number;
  /** `timeRemaining()` at the start of the last idle period seen. */
  lastIdleRemainingMs: number | null;
};

/**
 * The page part. Runs in the page, through `executeAsyncScript`, so it must
 * not reference anything outside its own body; `requestIdleCallback`,
 * `setTimeout`, `clearTimeout` and `performance` are on every build's LavaMoat
 * scuttling exception list.
 *
 * With a heartbeat, a timer reschedules itself every `tickMs`, and any gap
 * between two of its runs over `stallMs` restarts the count; once it has run
 * for `windowMs` without one, the part asks for idle periods. Each idle
 * callback asks for the next, which the browser runs no earlier than the next
 * idle period, as `resolveAfterTwoIdlePeriods` does for two.
 *
 * @param args - One-element tuple holding the part and the timer delay.
 * @param args."0" - The part's thresholds, and the heartbeat's timer delay.
 * @param done - Ends the script with the reading.
 */
export function waitForPageQuietInPage(
  [part]: [PagePart & { tickMs: number }],
  done: (reading: PageQuietReading) => void,
): void {
  const start = performance.now();
  const reading: PageQuietReading = {
    outcome: 'capped',
    waitedMs: 0,
    heartbeatHeldAtMs: null,
    largestGapMs: null,
    idlePeriods: 0,
    lastIdleRemainingMs: null,
  };
  let finished = false;
  const timers: { cap?: ReturnType<typeof setTimeout> } = {};
  const finish = (outcome: PageQuietReading['outcome']): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timers.cap);
    reading.outcome = outcome;
    reading.waitedMs = performance.now() - start;
    done(reading);
  };
  timers.cap = setTimeout(() => finish('capped'), part.capMs);

  const nextIdlePeriod = (): void => {
    requestIdleCallback((deadline) => {
      if (finished) {
        return;
      }
      reading.idlePeriods += 1;
      reading.lastIdleRemainingMs = deadline.timeRemaining();
      if (reading.idlePeriods >= part.idlePeriods) {
        finish('quiet');
      } else {
        nextIdlePeriod();
      }
    });
  };

  const { heartbeat } = part;
  if (heartbeat === null) {
    nextIdlePeriod();
    return;
  }
  let lastRun = start;
  let onTimeSince = start;
  const tick = (): void => {
    if (finished) {
      return;
    }
    const now = performance.now();
    const gap = now - lastRun;
    lastRun = now;
    reading.largestGapMs = Math.max(reading.largestGapMs ?? 0, gap);
    if (gap > heartbeat.stallMs) {
      onTimeSince = now;
    }
    if (now - onTimeSince >= heartbeat.windowMs) {
      reading.heartbeatHeldAtMs = now - start;
      nextIdlePeriod();
      return;
    }
    setTimeout(tick, part.tickMs);
  };
  setTimeout(tick, part.tickMs);
}

/** What {@link waitForBackgroundIdleInPage} reports. */
export type BackgroundIdleReading = {
  outcome: 'idle' | 'capped' | 'unreadable';
  waitedMs: number;
  /** Messages answered. */
  answered: number;
  /** Of those, how many by the port closing with no listener answering. */
  portClosed: number;
  /** How long the last answer took. */
  lastAnswerMs: number | null;
  /** How long every answer has been within `answerMs`, at the end. */
  promptForMs: number | null;
  /** Why the part could not be read. */
  reason: string | null;
};

/**
 * The background part. Runs in the page, through `executeAsyncScript`, so it
 * must not reference anything outside its own body. It reaches the background
 * through `chrome.runtime.sendMessage`, with one message in flight, sending
 * the next `pauseMs` after each answer, and checks every `checkMs` whether
 * every message sent in the last `windowMs` was answered within `answerMs`,
 * with the one in flight sent less than `answerMs` ago.
 *
 * A message is answered either by a listener or, when every listener has run
 * and none answered, by the browser closing its port; both take as long as
 * the background takes to reach it. Any other error means the message never
 * reached a listener, and the part reports `unreadable` rather than pass on
 * the browser's reply.
 *
 * @param args - One-element tuple holding the part and its constants.
 * @param args."0" - The part's thresholds and the message to send.
 * @param done - Ends the script with the reading.
 */
export function waitForBackgroundIdleInPage(
  [part]: [
    BackgroundPart & {
      pauseMs: number;
      checkMs: number;
      message: unknown;
      portClosed: string;
    },
  ],
  done: (reading: BackgroundIdleReading) => void,
): void {
  const start = performance.now();
  const reading: BackgroundIdleReading = {
    outcome: 'capped',
    waitedMs: 0,
    answered: 0,
    portClosed: 0,
    lastAnswerMs: null,
    promptForMs: null,
    reason: null,
  };
  const { runtime } = (
    window as unknown as {
      chrome?: {
        runtime?: {
          sendMessage?: (message: unknown, callback: () => void) => void;
          lastError?: { message?: string };
        };
      };
    }
  ).chrome ?? { runtime: undefined };
  let finished = false;
  let promptSince: number | null = null;
  let inFlightSince: number | null = null;
  let check: ReturnType<typeof setTimeout> | undefined;
  const finish = (
    outcome: BackgroundIdleReading['outcome'],
    reason: string | null = null,
  ): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(check);
    const now = performance.now();
    reading.outcome = outcome;
    reading.reason = reason;
    reading.waitedMs = now - start;
    reading.promptForMs = promptSince === null ? null : now - promptSince;
    done(reading);
  };
  if (!runtime || typeof runtime.sendMessage !== 'function') {
    finish('unreadable', 'chrome.runtime.sendMessage is not available here');
    return;
  }
  const sendMessage = runtime.sendMessage.bind(runtime);

  const send = (): void => {
    if (finished) {
      return;
    }
    const sentAt = performance.now();
    inFlightSince = sentAt;
    try {
      sendMessage(part.message, () => {
        const answeredAt = performance.now();
        // Reading `lastError` also marks it handled.
        const error = runtime.lastError;
        inFlightSince = null;
        if (finished) {
          return;
        }
        if (error && !String(error.message).includes(part.portClosed)) {
          finish('unreadable', `the message was rejected: ${error.message}`);
          return;
        }
        reading.answered += 1;
        if (error) {
          reading.portClosed += 1;
        }
        reading.lastAnswerMs = answeredAt - sentAt;
        if (reading.lastAnswerMs >= part.answerMs) {
          promptSince = null;
        } else if (promptSince === null) {
          promptSince = sentAt;
        }
        setTimeout(send, part.pauseMs);
      });
    } catch (error) {
      finish('unreadable', `sendMessage threw: ${String(error)}`);
    }
  };

  const checkCondition = (): void => {
    if (finished) {
      return;
    }
    const now = performance.now();
    if (
      promptSince !== null &&
      now - promptSince >= part.windowMs &&
      (inFlightSince === null || now - inFlightSince < part.answerMs)
    ) {
      finish('idle');
      return;
    }
    if (now - start >= part.capMs) {
      finish('capped');
      return;
    }
    check = setTimeout(checkCondition, part.checkMs);
  };

  send();
  checkCondition();
}

/**
 * Run a page function through `executeAsyncScript`. When tsx has named its
 * inner functions with `__name()`, define `__name` in the page first, as
 * `Driver.executeScript` does (`webdriver/driver.js:192-204`);
 * `Driver.executeAsyncScript` passes the function through unwrapped.
 *
 * @param driver - The WebDriver instance.
 * @param script - The page function.
 * @param args - Its arguments, handed to it as one array.
 * @returns What the function passed to its callback.
 */
export async function executeAsyncInPage(
  driver: Driver,
  script: (...args: never[]) => void,
  ...args: unknown[]
): Promise<unknown> {
  const source = script.toString();
  return await driver.executeAsyncScript(
    source.includes('__name')
      ? `var __name = (fn) => fn; return (${source}).apply(null, arguments);`
      : script,
    ...args,
  );
}

const ms = (value: number): string => value.toFixed(1);

/**
 * Log the failure and throw it.
 *
 * @param stepId - The step the wait precedes.
 * @param message - Which part, and why.
 */
function fail(stepId: string, message: string): never {
  console.log(`[benchmark] ${stepId} trigger-quiet failed: ${message}`);
  throw new TriggerQuietError(`trigger-quiet ${message}`);
}

async function waitForBackgroundIdle(
  driver: Driver,
  stepId: string,
  part: BackgroundPart,
): Promise<string> {
  let reading: BackgroundIdleReading;
  try {
    reading = (await executeAsyncInPage(driver, waitForBackgroundIdleInPage, {
      ...part,
      pauseMs: BACKGROUND_PAUSE_MS,
      checkMs: BACKGROUND_CHECK_MS,
      message: BACKGROUND_MESSAGE,
      portClosed: PORT_CLOSED_WITHOUT_ANSWER,
    })) as BackgroundIdleReading;
  } catch (error) {
    return fail(stepId, `background unreadable: ${(error as Error).message}`);
  }
  const last = `${reading.answered} message(s) answered, ${
    reading.portClosed
  } of them by the port closing unanswered, the last in ${
    reading.lastAnswerMs === null ? 'none' : `${ms(reading.lastAnswerMs)} ms`
  }, every one within ${part.answerMs} ms for ${
    reading.promptForMs === null ? 'none' : `${ms(reading.promptForMs)} ms`
  } (${part.windowMs} ms asked)`;
  if (reading.outcome === 'unreadable') {
    return fail(
      stepId,
      `background unreadable after ${ms(reading.waitedMs)} ms: ${
        reading.reason
      }; ${last}`,
    );
  }
  if (reading.outcome !== 'idle') {
    return fail(
      stepId,
      `background capped at ${ms(reading.waitedMs)} ms (cap ${
        part.capMs
      } ms): ${last}`,
    );
  }
  return `trigger-quiet background idle after ${ms(reading.waitedMs)} ms: ${last}`;
}

async function waitForMockQuiet(
  stepId: string,
  { traffic, quietMs, capMs }: MockPart,
): Promise<string> {
  const start = Date.now();
  const at = { ...traffic };
  for (;;) {
    const now = Date.now();
    const waited = now - start;
    const quiet = now - traffic.lastReceivedAt;
    const last = `${quiet} ms since the last request (${quietMs} ms asked), ${
      traffic.awaiting.size
    } awaiting an answer, and during the wait ${
      traffic.received - at.received
    } received, ${traffic.answered - at.answered} answered, ${
      traffic.aborted - at.aborted
    } aborted`;
    if (quiet >= quietMs && traffic.awaiting.size === 0) {
      return `trigger-quiet mock quiet after ${waited} ms: ${last}`;
    }
    if (waited >= capMs) {
      return fail(
        stepId,
        `mock capped at ${waited} ms (cap ${capMs} ms): ${last}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MOCK_POLL_MS));
  }
}

async function waitForPageQuiet(
  driver: Driver,
  stepId: string,
  part: PagePart,
): Promise<string> {
  let reading: PageQuietReading;
  try {
    reading = (await executeAsyncInPage(driver, waitForPageQuietInPage, {
      ...part,
      tickMs: HEARTBEAT_TICK_MS,
    })) as PageQuietReading;
  } catch (error) {
    return fail(stepId, `page unreadable: ${(error as Error).message}`);
  }
  const heartbeat = part.heartbeat
    ? `heartbeat ${
        reading.heartbeatHeldAtMs === null
          ? `never ran ${part.heartbeat.windowMs} ms without a gap over ${part.heartbeat.stallMs} ms`
          : `ran ${part.heartbeat.windowMs} ms without a gap over ${
              part.heartbeat.stallMs
            } ms by +${ms(reading.heartbeatHeldAtMs)} ms`
      } (largest gap ${
        reading.largestGapMs === null
          ? 'none'
          : `${ms(reading.largestGapMs)} ms`
      }), then `
    : '';
  const last = `${heartbeat}${reading.idlePeriods} of ${
    part.idlePeriods
  } idle period(s), the last with ${
    reading.lastIdleRemainingMs === null
      ? 'none'
      : `${ms(reading.lastIdleRemainingMs)} ms`
  } remaining`;
  if (reading.outcome !== 'quiet') {
    return fail(
      stepId,
      `page capped at ${ms(reading.waitedMs)} ms (cap ${part.capMs} ms): ${last}`,
    );
  }
  return `trigger-quiet page idle after ${ms(reading.waitedMs)} ms: ${last}`;
}

/**
 * Wait until the parts given hold, in the order background, mock, page, each
 * within its cap. Call it after the last harness action before the trigger,
 * outside the timed interval: as a step's `readBeforeTrigger`, or just before
 * the trigger's own click.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step the wait precedes, for the log.
 * @param parts - The parts to run, with their thresholds.
 * @param parts.background - The background part, or none.
 * @param parts.mock - The mock part, or none.
 * @param parts.page - The page part, or none.
 * @returns One readings-line part per part run: the time it waited and its
 * last reading.
 * @throws {TriggerQuietError} When a part reaches its cap or cannot be read.
 */
export async function waitForTriggerQuiet(
  driver: Driver,
  stepId: string,
  { background, mock, page }: TriggerQuietParts,
): Promise<string[]> {
  const readings: string[] = [];
  if (background) {
    readings.push(await waitForBackgroundIdle(driver, stepId, background));
  }
  if (mock) {
    readings.push(await waitForMockQuiet(stepId, mock));
  }
  if (page) {
    readings.push(await waitForPageQuiet(driver, stepId, page));
  }
  return readings;
}

/**
 * Move the pointer onto an element with WebDriver actions, then hold it there
 * for `holdMs`, so the page handles the pointer's arrival before the next
 * harness action rather than with the click.
 *
 * @param driver - The WebDriver instance.
 * @param selector - The element, as CSS.
 * @param holdMs - How long to hold the pointer there.
 * @returns The readings-line part: how long the move took and the hold.
 */
export async function movePointerOnto(
  driver: Driver,
  selector: string,
  holdMs: number,
): Promise<string> {
  const start = Date.now();
  const element = await driver.findElement(selector);
  await driver.driver
    .actions({ async: true })
    .move({ origin: element })
    .perform();
  const moved = Date.now();
  await driver.delay(holdMs);
  return `pointer moved onto ${selector} in ${moved - start} ms, then held ${
    Date.now() - moved
  } ms`;
}
