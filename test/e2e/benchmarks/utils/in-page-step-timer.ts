import type { CompletedRequest, Mockttp } from 'mockttp';
import type { Driver } from '../../webdriver/driver';
import { getKnownAnswerDelayMs } from '../mocks/known-answer';
import type { TimerResult } from './types';

/**
 * In-page step timing.
 *
 * The step timer in `measureStepWithLongTasks` reads the harness clock and,
 * in most journey steps, starts after the click that triggers the step has
 * already returned. This module times the same step a second time, inside the
 * page: from the trusted input event that triggers the step to the moment the
 * destination's key elements are in the DOM, both read with
 * `performance.now()`. The result is reported under the step id itself,
 * `<stepId>`, beside the existing timer, which is reported as
 * `<stepId>Legacy` and is otherwise left exactly as it was, so one run
 * carries both.
 *
 * The end is `performance.now()` in the first `MutationObserver` callback in
 * which every end selector matches. Callbacks run at the first microtask
 * checkpoint after a change, no later than the end of the task that made it,
 * so the end is when that change's script finished; it is not a paint.
 *
 * The test build's LavaMoat scuttling hides most globals from scripts that
 * run in the page outside LavaMoat, as this probe does through
 * `executeScript`. `MutationObserver` is on the test-only part of the
 * exception list in `development/webpack/utils/plugins/LavamoatPlugin/index.ts`
 * for this probe; `setTimeout`, `clearTimeout` and `performance` are on the
 * part every build lists, as are `Date` and `stateHooks`.
 *
 * Observing starts at the triggering input, not at install, and stops at the
 * first match, at the read, or `boundMs` after the trigger, whichever comes
 * first, so no observer outlives its step.
 *
 * Beside the value, each reading records the trigger's own `event.timeStamp`,
 * so the input delay before the listener ran can be read; for a typed
 * trigger, how many characters were typed and when the last of them arrived,
 * which measures the harness's typing inside the interval; and the page
 * clock's offset from the wall clock, so the interval can be compared with
 * the mock server's request times ({@link logRequestsWithinInPageSteps}). The
 * log line after the value reports the first two. None of them changes the
 * value.
 *
 * Known answer: with `BENCHMARK_KNOWN_ANSWER_INPAGE_MS` above 0 and the step
 * named in `BENCHMARK_KNOWN_ANSWER_INPAGE_STEP`, the probe holds the page's
 * main thread for that many ms as soon as it records the trigger. Its listener
 * is a capture listener on `document`, so it runs before any handler the app
 * registers on an element inside the document, and what the app does in
 * response starts that much later. Unset or 0, nothing is held.
 *
 * An iteration reports nothing for the step, never zero, and logs why, when:
 * - no trusted input reached the trigger after the probe was installed;
 * - the destination was already in the DOM when the trigger fired, so the
 * selector does not distinguish this step's destination;
 * - a further trusted input arrived between the trigger and the destination,
 * so the region contains the harness's own reaction time;
 * - the destination did not appear within the bound, appeared without a DOM
 * change the observer saw, or the probe was lost with its document.
 */

/** How long after its trigger a probe keeps observing for the destination. */
export const IN_PAGE_BOUND_MS = 60_000;

/**
 * The known-answer hold, in ms: how long the probe holds the page's main
 * thread at the trigger of a step named in
 * {@link KNOWN_ANSWER_INPAGE_STEP}. Unset, empty or 0 holds nothing.
 */
export const KNOWN_ANSWER_INPAGE_MS = 'BENCHMARK_KNOWN_ANSWER_INPAGE_MS';

/**
 * The steps the known-answer hold applies to: a step id, or a comma-separated
 * list of them. A step id is the in-page timer's own name, with no suffix. A
 * step id that more than one flow uses is held in each of them.
 */
export const KNOWN_ANSWER_INPAGE_STEP = 'BENCHMARK_KNOWN_ANSWER_INPAGE_STEP';

/**
 * Read the known-answer hold for one step.
 *
 * A hold set above 0 with no step named throws, as an invalid known-answer
 * delay does, so a run meant as a lever arm cannot run as an unchanged one.
 * For the same reason, so does a name ending in `InPage` or `Legacy`: no step
 * id has either suffix, so the name would match nothing.
 *
 * @param stepId - The step id the probe is installed under.
 * @returns The hold in ms: 0 unless the hold is set and names this step.
 */
export function getInPageKnownAnswerMs(stepId: string): number {
  const holdMs = getKnownAnswerDelayMs(KNOWN_ANSWER_INPAGE_MS);
  if (holdMs === 0) {
    return 0;
  }
  const named = (process.env[KNOWN_ANSWER_INPAGE_STEP] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (named.length === 0) {
    throw new Error(
      `${KNOWN_ANSWER_INPAGE_MS} is ${holdMs}, but ${KNOWN_ANSWER_INPAGE_STEP} names no step`,
    );
  }
  const suffixed = named.filter((name) => /(?:InPage|Legacy)$/u.test(name));
  if (suffixed.length > 0) {
    throw new Error(
      `${KNOWN_ANSWER_INPAGE_STEP} names steps by step id, without a suffix: ${suffixed.join(', ')}`,
    );
  }
  return named.includes(stepId) ? holdMs : 0;
}

/**
 * The page-side probe's configuration. It crosses `executeScript`, so it must
 * be plain JSON.
 */
export type InPageProbeConfig = {
  stepId: string;
  /** CSS selectors that must all match for the destination to be reached. */
  endSelectors: string[];
  /** When set, only input whose target is inside a match starts the region. */
  startWithin: string | null;
  /** When true, only a keydown that types a character starts the region. */
  typedOnly: boolean;
  /** Stop observing this long after the trigger. */
  boundMs: number;
  /** Hold the main thread this long at the trigger: the known answer. */
  holdMs: number;
  /** Reset the app's long-task metrics at the trigger. */
  resetLongTasks: boolean;
};

/**
 * One reading of a probe, as {@link readInPageStepProbe} returns it.
 */
export type InPageProbeReading = {
  /** `performance.now()` at the triggering input, or null if none arrived. */
  start: number | null;
  /** `performance.now()` in the first observer callback that matched. */
  end: number | null;
  /** The event type that started the region. */
  startEvent: string | null;
  /** The destination already matched when the triggering input arrived. */
  preexisting: boolean;
  /** Trusted inputs after the trigger and before the destination matched. */
  extraInputs: number;
  /** Observing stopped at the bound without the destination matching. */
  timedOut: boolean;
  /** The destination is in the DOM, but no observer callback recorded it. */
  unobserved: boolean;
  /**
   * The triggering event's `event.timeStamp`, on the same clock as `start`.
   * `start` minus this is the input delay: how long the event waited before
   * the listener ran. It is outside the value.
   */
  startTimeStamp: number | null;
  /** Typed characters from the trigger to the destination; 0 if not typed. */
  typedKeys: number;
  /** `performance.now()` at the last of those typed characters. */
  lastTypedAt: number | null;
  /** How long the known-answer hold actually held, in ms; 0 when none. */
  heldMs: number;
  /** The app's long-task metrics were reset at the trigger. */
  longTasksReset: boolean;
  /**
   * `Date.now() - performance.now()` when read: add it to `start` or `end`
   * for a wall-clock time comparable with the mock server's request times.
   */
  epochOffset: number;
};

/** A step's reading, as {@link finishInPageStep} hands it to `onReading`. */
export type InPageStepReading = {
  stepId: string;
  reading: InPageProbeReading | null;
};

type InPageProbe = {
  start: number | null;
  end: number | null;
  startEvent: string | null;
  preexisting: boolean;
  extraInputs: number;
  timedOut: boolean;
  startTimeStamp: number | null;
  typedKeys: number;
  lastTypedAt: number | null;
  heldMs: number;
  longTasksReset: boolean;
  matches: () => boolean;
  stop: () => void;
};

type ProbeHost = {
  // A page global the harness owns, named apart from the app's own.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __benchSteps?: Record<string, InPageProbe>;
  stateHooks?: { resetLongTaskMetrics?: () => void };
};

/**
 * Install a probe for one step. Runs in the page.
 *
 * `Driver.executeScript(fn, ...args)` hands `fn` a single argument, the array
 * of `args`, which is why this takes a one-element tuple. The function is
 * serialized into the page, so it must not reference anything outside its own
 * body, and under the test build's LavaMoat scuttling it may use only the
 * globals on that build's exception list, plus `document`.
 *
 * Capture-phase listeners on `document` record the first trusted pointerdown,
 * mousedown, click or keydown that qualifies as the trigger. From then a
 * `MutationObserver` on the whole document checks the end selectors after
 * each batch of changes, and records the time of the first callback in which
 * they all match.
 *
 * At the trigger, the listener resets the app's long-task metrics when
 * `resetLongTasks` is set, just before it reads the start, and holds the main
 * thread for `holdMs` just after, when that is above 0. Both happen before any
 * handler the app registers on an element inside the document sees the event.
 *
 * @param args - One-element tuple holding the probe configuration.
 * @param args."0" - The probe configuration.
 * @returns Null when installed, or the reason it could not be.
 */
export function installInPageStepProbe([config]: [InPageProbeConfig]):
  | string
  | null {
  const host = window as unknown as ProbeHost;
  const probes = host.__benchSteps ?? {};
  host.__benchSteps = probes;
  probes[config.stepId]?.stop();
  delete probes[config.stepId];

  try {
    for (const selector of config.endSelectors) {
      document.querySelector(selector);
    }
    if (config.startWithin !== null) {
      document.querySelector(config.startWithin);
    }
  } catch (error) {
    return `invalid selector: ${String(error)}`;
  }

  const inputTypes = ['pointerdown', 'mousedown', 'click', 'keydown'];
  let bound: ReturnType<typeof setTimeout> | undefined;

  const matches = (): boolean =>
    config.endSelectors.every(
      (selector) => document.querySelector(selector) !== null,
    );

  const isTypedCharacter = (event: Event): boolean => {
    // A character key, not a modifier chord: `driver.fill` clears the field
    // with Ctrl/Cmd+A and Backspace before it types.
    const { key, ctrlKey, metaKey, altKey } = event as KeyboardEvent;
    return (
      event.type === 'keydown' &&
      typeof key === 'string' &&
      key.length === 1 &&
      !ctrlKey &&
      !metaKey &&
      !altKey
    );
  };

  const startsRegion = (event: Event): boolean => {
    if (config.startWithin !== null) {
      const { target } = event;
      if (
        !(target instanceof Element) ||
        target.closest(config.startWithin) === null
      ) {
        return false;
      }
    }
    if (config.typedOnly) {
      return isTypedCharacter(event);
    }
    return true;
  };

  const probe: InPageProbe = {
    start: null,
    end: null,
    startEvent: null,
    preexisting: false,
    extraInputs: 0,
    timedOut: false,
    startTimeStamp: null,
    typedKeys: 0,
    lastTypedAt: null,
    heldMs: 0,
    longTasksReset: false,
    matches,
    stop: () => undefined,
  };

  let observer: MutationObserver;
  try {
    observer = new MutationObserver(() => {
      if (probe.start === null || probe.end !== null || !matches()) {
        return;
      }
      probe.end = performance.now();
      probe.stop();
    });
  } catch (error) {
    // The build in the browser does not list `MutationObserver` among its
    // scuttling exceptions.
    return `MutationObserver unavailable: ${String(error)}`;
  }

  const onInput = (event: Event): void => {
    if (!event.isTrusted) {
      return;
    }
    if (probe.start === null) {
      if (!startsRegion(event)) {
        return;
      }
      // Before the start is read, so the reset is not inside the value.
      if (config.resetLongTasks) {
        const hooks = host.stateHooks;
        if (typeof hooks?.resetLongTaskMetrics === 'function') {
          hooks.resetLongTaskMetrics();
          probe.longTasksReset = true;
        }
      }
      probe.start = performance.now();
      probe.startEvent = event.type;
      probe.startTimeStamp = event.timeStamp;
      if (config.typedOnly) {
        probe.typedKeys = 1;
        probe.lastTypedAt = probe.start;
      }
      if (config.holdMs > 0) {
        // The known answer. Nothing else runs on this thread meanwhile, so
        // the DOM the check below reads is still the DOM at the trigger.
        const holdStart = performance.now();
        while (performance.now() - holdStart < config.holdMs) {
          // Hold the main thread.
        }
        probe.heldMs = performance.now() - holdStart;
      }
      if (matches()) {
        probe.preexisting = true;
        probe.stop();
        return;
      }
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      bound = setTimeout(() => {
        probe.timedOut = true;
        probe.stop();
      }, config.boundMs);
      return;
    }
    if (config.typedOnly && probe.end === null && startsRegion(event)) {
      probe.typedKeys += 1;
      probe.lastTypedAt = performance.now();
    }
    // One gesture is one pointerdown or one keydown; the mousedown and click
    // that follow a pointerdown belong to it. Typing continues the trigger
    // when the trigger is typed. Input after the destination matched belongs
    // to the next step.
    const anotherGesture =
      event.type === 'pointerdown' ||
      (event.type === 'keydown' && !config.typedOnly);
    if (anotherGesture && probe.end === null) {
      probe.extraInputs += 1;
    }
  };

  probe.stop = () => {
    observer.disconnect();
    if (bound !== undefined) {
      clearTimeout(bound);
      bound = undefined;
    }
    for (const type of inputTypes) {
      document.removeEventListener(type, onInput, true);
    }
  };

  for (const type of inputTypes) {
    document.addEventListener(type, onInput, true);
  }
  probes[config.stepId] = probe;
  return null;
}

/**
 * Read a step's probe and remove it, stopping its observer. Runs in the page.
 *
 * An observer callback runs no later than the end of the task that changed the
 * DOM, so by the time this read runs, in a task of its own, every change made
 * before it has been seen. A destination that matches now with no recorded end appeared
 * without a change the observer reports, and is flagged as `unobserved`.
 *
 * @param args - One-element tuple holding the step id.
 * @param args."0" - The step id the probe was installed under.
 * @returns The reading, or null when no probe exists in this document.
 */
export function readInPageStepProbe([stepId]: [
  string,
]): InPageProbeReading | null {
  const host = window as unknown as ProbeHost;
  const probe = host.__benchSteps?.[stepId];
  if (!probe) {
    return null;
  }
  probe.stop();
  delete host.__benchSteps?.[stepId];
  return {
    start: probe.start,
    end: probe.end,
    startEvent: probe.startEvent,
    preexisting: probe.preexisting,
    extraInputs: probe.extraInputs,
    timedOut: probe.timedOut,
    unobserved:
      probe.start !== null &&
      probe.end === null &&
      !probe.preexisting &&
      probe.matches(),
    startTimeStamp: probe.startTimeStamp,
    typedKeys: probe.typedKeys,
    lastTypedAt: probe.lastTypedAt,
    heldMs: probe.heldMs,
    longTasksReset: probe.longTasksReset,
    epochOffset: Date.now() - performance.now(),
  };
}

/**
 * Describe the readings recorded beside a value: the input delay, the typing
 * inside a typed step, the known-answer hold, and whether the long-task window
 * opened at the trigger.
 *
 * @param reading - A reading with a start.
 * @returns One line of `; `-separated parts.
 */
function describeReadings(reading: InPageProbeReading): string {
  const parts: string[] = [];
  const start = reading.start ?? 0;
  if (reading.startTimeStamp !== null && reading.startTimeStamp > 0) {
    const delay = start - reading.startTimeStamp;
    parts.push(
      delay >= 0 && delay <= IN_PAGE_BOUND_MS
        ? `input delay ${delay.toFixed(1)} ms (event.timeStamp to listener)`
        : `event.timeStamp ${reading.startTimeStamp.toFixed(1)} is not on the listener's clock (${start.toFixed(1)})`,
    );
  } else {
    parts.push('no event.timeStamp');
  }
  if (reading.typedKeys > 0 && reading.lastTypedAt !== null) {
    parts.push(
      `${reading.typedKeys} typed key(s), the last at +${(
        reading.lastTypedAt - start
      ).toFixed(1)} ms`,
    );
  }
  if (reading.heldMs > 0) {
    parts.push(`known-answer hold ${reading.heldMs.toFixed(1)} ms`);
  }
  if (reading.longTasksReset) {
    parts.push('long-task window opened at the trigger');
  }
  return parts.join('; ');
}

/**
 * Turn a reading into the step's in-page timer, reported as `<stepId>`, or
 * into nothing with the reason logged. Absent, never zero.
 *
 * The value runs from the triggering input to the first observer callback
 * that sees all of the destination's key elements in the DOM, which runs once
 * the script that added the last of them has finished. It includes no paint.
 *
 * Tagged with a unit, as the trace timers in `sentry-transactions.ts` are, so
 * `runner.ts` leaves it out of the per-run `total`, which sums only untagged
 * timers: it overlaps the step's legacy timer, and adding both would count the
 * same time twice.
 *
 * @param stepId - The step id the probe was installed under.
 * @param reading - The final reading, or null when no probe was found.
 * @returns The timer, or an empty array.
 */
export function inPageTimerResult(
  stepId: string,
  reading: InPageProbeReading | null,
): TimerResult[] {
  const absent = (reason: string): TimerResult[] => {
    console.log(`[benchmark] ${stepId} absent: ${reason}`);
    return [];
  };

  if (reading === null) {
    return absent(
      'no probe in this document; it was not installed, or the page was replaced',
    );
  }
  if (reading.start === null) {
    return absent(
      'no trusted input reached the trigger after the probe was installed',
    );
  }
  if (reading.preexisting) {
    return absent(
      'the destination was already in the DOM when the trigger fired',
    );
  }
  if (reading.extraInputs > 0) {
    return absent(
      `${reading.extraInputs} further trusted input(s) arrived between the trigger and the destination, so the region contains harness time`,
    );
  }
  if (reading.end === null) {
    if (reading.timedOut) {
      return absent('the destination did not appear within the bound');
    }
    return absent(
      reading.unobserved
        ? 'the destination is in the DOM, but no observed DOM change put it there'
        : 'the destination did not appear after the trigger',
    );
  }

  const value = reading.end - reading.start;
  console.log(
    `[benchmark] ${stepId}: ${value.toFixed(1)} ms from ${reading.startEvent}`,
  );
  console.log(`[benchmark] ${stepId} readings: ${describeReadings(reading)}`);
  return [{ id: stepId, value, unit: 'ms' }];
}

export type InPageStepOptions = {
  /**
   * The destination's key element: CSS selectors that must all be in the DOM.
   * Each must be absent when the trigger fires.
   */
  endSelector: string | readonly string[];
  /**
   * Restrict the trigger to input on this element or inside it. Needed when the
   * call that triggers the step makes other inputs first: typing a password
   * before clicking Unlock, or picking tokens before entering an amount.
   */
  startWithin?: string;
  /**
   * Start on the first typed character rather than on any input, so the clear
   * chord `driver.fill` sends first, and the 200 ms it then waits, stay out.
   */
  typedOnly?: boolean;
  /**
   * Reset the app's long-task metrics at the trigger, so the step's long-task
   * window opens at the same input its in-page value starts at. The harness
   * cannot reset there itself when the call that triggers the step makes
   * other inputs first, as `createSwap` picks tokens before it types. The
   * step's long-task timer is then told not to reset again
   * (`measureStepWithLongTasks`'s `windowOpenedAtTrigger`).
   */
  resetLongTasksAtStart?: boolean;
};

/**
 * Install a probe before a step's trigger runs. A failure is logged and never
 * thrown, so the step's existing timer is unaffected by it. A known-answer
 * hold set without a step to apply to is a configuration error, and throws.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id, which is also the in-page timer's name.
 * @param options - Where the step ends, and what may start it.
 * @returns Whether the probe was installed.
 */
export async function startInPageStep(
  driver: Driver,
  stepId: string,
  options: InPageStepOptions,
): Promise<boolean> {
  const config: InPageProbeConfig = {
    stepId,
    endSelectors: ([] as string[]).concat(options.endSelector),
    startWithin: options.startWithin ?? null,
    typedOnly: options.typedOnly ?? false,
    boundMs: IN_PAGE_BOUND_MS,
    holdMs: getInPageKnownAnswerMs(stepId),
    resetLongTasks: options.resetLongTasksAtStart ?? false,
  };
  if (config.holdMs > 0) {
    console.log(
      `[benchmark] ${stepId}: known-answer hold of ${config.holdMs} ms at the trigger`,
    );
  }
  try {
    const failure = (await driver.executeScript(
      installInPageStepProbe,
      config,
    )) as string | null;
    if (failure !== null) {
      console.log(`[benchmark] ${stepId} not installed: ${failure}`);
      return false;
    }
    return true;
  } catch (error) {
    console.log(
      `[benchmark] ${stepId} not installed: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Read a step's probe once and turn it into its timer. Call it once the
 * step's existing wait has returned. It never waits for a destination that has
 * not appeared. A failure is logged and never thrown.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id the probe was installed under.
 * @param onReading - Receives the reading, for a caller that logs more than
 * the value (see {@link logRequestsWithinInPageSteps}). Not called when the
 * probe could not be read.
 * @returns The step's in-page timer, or an empty array.
 */
export async function finishInPageStep(
  driver: Driver,
  stepId: string,
  onReading?: (stepReading: InPageStepReading) => void,
): Promise<TimerResult[]> {
  try {
    const reading = (await driver.executeScript(
      readInPageStepProbe,
      stepId,
    )) as InPageProbeReading | null;
    onReading?.({ stepId, reading });
    return inPageTimerResult(stepId, reading);
  } catch (error) {
    console.log(
      `[benchmark] ${stepId} absent: the probe could not be read: ${
        (error as Error).message
      }`,
    );
    return [];
  }
}

/**
 * Time a step inside the page, around its existing harness-clock timer.
 *
 * Installs the probe, runs the trigger, runs `settle` (the step's existing
 * timed wait, unchanged), then reads the probe. The trigger keeps its
 * position relative to the existing timer: it runs before `settle` exactly as
 * it ran before the timed wait. Errors from either are thrown as before.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id, which is also the in-page timer's name.
 * @param options - The probe options, plus the trigger and the timed wait.
 * @param options.trigger - The harness action that starts the step.
 * @param options.settle - The step's existing timed wait. It is told whether
 * the probe was installed, so a step that asked the probe to open its
 * long-task window at the trigger can open it itself when it was not.
 * @param options.onReading - Receives the probe's reading; see
 * {@link finishInPageStep}.
 * @returns The step's in-page timer, or an empty array.
 */
export async function measureStepInPage(
  driver: Driver,
  stepId: string,
  {
    trigger,
    settle,
    onReading,
    ...options
  }: InPageStepOptions & {
    trigger: () => Promise<void>;
    settle: (probe: { installed: boolean }) => Promise<void>;
    onReading?: (stepReading: InPageStepReading) => void;
  },
): Promise<TimerResult[]> {
  const installed = await startInPageStep(driver, stepId, options);
  await trigger();
  await settle({ installed });
  return installed ? await finishInPageStep(driver, stepId, onReading) : [];
}

/** The parts of a request the mock server saw that the request log reads. */
export type SeenRequest = Pick<
  CompletedRequest,
  'method' | 'url' | 'timingEvents'
>;

/** How long the request log waits for each mock rule's record of requests. */
export const SEEN_REQUESTS_TIMEOUT_MS = 5_000;

/** The most request groups listed for one step. */
const MAX_REQUEST_GROUPS = 40;

/**
 * When the mock server received a request, and when it finished answering
 * it, on the wall clock. `startTime` is `Date.now()` at receipt; the other
 * timing events are on a monotonic clock whose origin `startTimestamp` gives.
 *
 * @param request - A request the mock server saw.
 * @returns Wall-clock ms; `answered` is null when no answer was recorded.
 */
function requestTimes(request: SeenRequest): {
  received: number;
  answered: number | null;
} {
  const { startTime, startTimestamp, responseSentTimestamp, abortedTimestamp } =
    request.timingEvents;
  const doneAt = responseSentTimestamp ?? abortedTimestamp;
  return {
    received: startTime,
    answered: doneAt === undefined ? null : startTime + doneAt - startTimestamp,
  };
}

function requestGroupKey(request: SeenRequest): string {
  try {
    const { host, pathname } = new URL(request.url);
    return `${request.method} ${host}${pathname}`;
  } catch {
    return `${request.method} ${request.url}`;
  }
}

const signedMs = (ms: number): string =>
  `${ms < 0 ? '-' : '+'}${Math.abs(ms).toFixed(0)}`;

const msRange = (min: number, max: number): string =>
  min === max ? signedMs(min) : `${signedMs(min)}..${signedMs(max)}`;

/**
 * List the requests the mock server was handling during one step's in-page
 * interval: those received inside it, and those received before it whose
 * answer came inside it or later. They are grouped by method, host and path,
 * with times in ms from the trigger. The page's interval is put on the wall
 * clock with the offset read beside it, so the times carry the two clocks'
 * millisecond resolution.
 *
 * @param stepReading - The step id and its reading.
 * @param stepReading.stepId - The step id the probe was installed under.
 * @param stepReading.reading - The probe's reading, or null.
 * @param requests - Every request the mock server saw in the iteration.
 * @returns The log text.
 */
export function describeRequestsWithinInPageStep(
  { stepId, reading }: InPageStepReading,
  requests: SeenRequest[],
): string {
  if (reading === null || reading.start === null || reading.end === null) {
    return `[benchmark] ${stepId} requests: not listed, the interval has no end`;
  }
  const start = reading.start + reading.epochOffset;
  const end = reading.end + reading.epochOffset;

  type Group = {
    key: string;
    count: number;
    unanswered: number;
    received: [number, number];
    answered: [number, number] | null;
  };
  const groups = new Map<string, Group>();
  let total = 0;
  for (const request of requests) {
    const { received, answered } = requestTimes(request);
    const overlaps =
      received <= end &&
      (answered === null ? received >= start : answered >= start);
    if (!overlaps) {
      continue;
    }
    total += 1;
    const key = requestGroupKey(request);
    const group = groups.get(key) ?? {
      key,
      count: 0,
      unanswered: 0,
      received: [Infinity, -Infinity],
      answered: null,
    };
    group.count += 1;
    group.received = [
      Math.min(group.received[0], received - start),
      Math.max(group.received[1], received - start),
    ];
    if (answered === null) {
      group.unanswered += 1;
    } else {
      group.answered = [
        Math.min(group.answered?.[0] ?? Infinity, answered - start),
        Math.max(group.answered?.[1] ?? -Infinity, answered - start),
      ];
    }
    groups.set(key, group);
  }

  const sorted = [...groups.values()].sort(
    (a, b) => a.received[0] - b.received[0] || a.key.localeCompare(b.key),
  );
  const lines = [
    `[benchmark] ${stepId} requests: ${total} at the mock server overlapped the ${(
      end - start
    ).toFixed(1)} ms interval (ms from the trigger)`,
    ...sorted.slice(0, MAX_REQUEST_GROUPS).map((group) => {
      const answered = group.answered
        ? `, answered ${msRange(...group.answered)}`
        : '';
      const unanswered =
        group.unanswered > 0 ? `, ${group.unanswered} without an answer` : '';
      return `  ${group.key} x${group.count}: received ${msRange(
        ...group.received,
      )}${answered}${unanswered}`;
    }),
  ];
  if (sorted.length > MAX_REQUEST_GROUPS) {
    lines.push(`  ... ${sorted.length - MAX_REQUEST_GROUPS} more group(s)`);
  }
  return lines.join('\n');
}

/**
 * Log, for each step, the requests the mock server was handling during its
 * in-page interval, so the slow iterations of a series can be compared with
 * the fast ones. Call it once per iteration, after the last measured step:
 * reading the mock server's record waits for requests still being answered,
 * and must not land inside or between steps. A rule whose record fails, or
 * is not ready within `timeoutMs`, is left out and counted. Never throws.
 *
 * @param mockServer - The iteration's mock server.
 * @param steps - The readings, as `onReading` received them.
 * @param timeoutMs - How long to wait for each rule's record.
 */
export async function logRequestsWithinInPageSteps(
  mockServer: Pick<Mockttp, 'getMockedEndpoints'>,
  steps: InPageStepReading[],
  timeoutMs: number = SEEN_REQUESTS_TIMEOUT_MS,
): Promise<void> {
  if (steps.length === 0) {
    return;
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const endpoints = await mockServer.getMockedEndpoints();
    const timedOut = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), timeoutMs);
    });
    const seen = await Promise.all(
      endpoints.map((endpoint) =>
        Promise.race([endpoint.getSeenRequests().catch(() => null), timedOut]),
      ),
    );
    const unread = seen.filter((requests) => requests === null).length;
    if (unread > 0) {
      console.log(
        `[benchmark] request log: ${unread} of ${endpoints.length} mock rules failed or gave no record within ${timeoutMs} ms; their requests are not listed`,
      );
    }
    const requests = seen.flatMap((ruleRequests) => ruleRequests ?? []);
    for (const step of steps) {
      console.log(describeRequestsWithinInPageStep(step, requests));
    }
  } catch (error) {
    console.log(
      `[benchmark] request log unavailable: ${(error as Error).message}`,
    );
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Destination key elements, as CSS. Each mirrors the CSS part of the
 * page-object method named beside it; text-only locators in those methods
 * have no CSS form and are not represented.
 */
export const IN_PAGE_DESTINATIONS = {
  /** `HomePage.checkPageIsLoaded`. */
  home: ['[data-testid="parent-selector-home"]'],
  /**
   * `HomePage.checkPageIsLoaded` plus `TokensTab.checkTokenListIsDisplayed`.
   */
  homeWithTokenList: [
    '[data-testid="parent-selector-home"]',
    '[data-testid="multichain-token-list-button"]',
  ],
  /**
   * `AccountListPage.checkPageIsLoaded`, without its sync wait: that wait
   * holds the add-wallet button out of its syncing label for 2 s, a harness
   * stability window rather than an element.
   */
  accountList: [
    '[data-testid="parent-selector-account-list-page"]',
    '[data-testid="add-multichain-account-button"]',
    '[data-testid="multichain-account-list-search"]',
  ],
  /** `SendPage.checkNetworkFilterToggleIsDisplayed`. */
  sendNetworkFilter: ['[data-testid="send-network-filter-toggle"]'],
  /** `SendPage.checkSendFormIsLoaded`. */
  sendForm: [
    '[data-testid="send-amount-input"]',
    '[data-testid="recipient-address-input"]',
  ],
  /** `SnapTransactionConfirmation.checkPageIsLoaded`. */
  snapConfirmation: [
    '[data-testid="parent-selector-snap-confirmation-page"]',
    '[data-testid="confirm-sign-and-send-transaction-cancel-snap-footer-button"]',
    '[data-testid="confirm-sign-and-send-transaction-confirm-snap-footer-button"]',
  ],
  /** `SwapPage.checkPageIsLoaded`. */
  swapPage: [
    '[data-testid="from-amount"]',
    '[data-testid="bridge-destination-button"]',
    '[data-testid="parent-selector-bridge-quote"]',
  ],
  /** `SwapPage.checkQuoteIsDisplayed`. */
  swapQuote: [
    '[data-testid="network-fees"]',
    '[data-testid="slippage-edit-button"]',
    '[data-testid="minimum-received"]',
  ],
  /** The asset picker's search input, which `BridgeQuotePage` waits on. */
  bridgeAssetPicker: ['[data-testid="bridge-asset-picker-search-input"]'],
  /** `StartOnboardingPage.checkUserSrpButtonIsVisible`. */
  onboardingImportOptions: [
    '[data-testid="onboarding-import-with-srp-button"]',
  ],
  /** `StartOnboardingPage.checkSocialSignUpFormIsVisible`. */
  onboardingCreateOptions: [
    '[data-testid="onboarding-create-with-google-button"]',
  ],
  /** `OnboardingSrpPage.checkPageIsLoaded`, Continue disabled as it waits. */
  onboardingSrp: [
    '[data-testid="parent-selector-onboarding-srp"]',
    '[data-testid="srp-input-import__srp-note"]',
    '[data-testid="import-srp-confirm"]:disabled',
  ],
  /** `OnboardingPasswordPage.checkPageIsLoaded`. */
  onboardingPassword: [
    '[data-testid="parent-selector-onboarding-password"]',
    '[data-testid="create-password-new-input"]',
    '[data-testid="create-password-confirm-input"]',
  ],
  /** `SetupPasskeyPage.checkPageIsLoaded`. */
  setupPasskey: [
    '[data-testid="parent-selector-setup-passkey"]',
    '[data-testid="passkey-maybe-later-button"]',
    '[data-testid="passkey-set-up-button"]',
  ],
  /** `SecureWalletPage.checkPageIsLoaded`. */
  onboardingSecureWallet: [
    '[data-testid="parent-selector-secure-wallet"]',
    '[data-testid="recovery-phrase-remind-later"]',
  ],
  /** `OnboardingMetricsPage.checkPageIsLoaded`. */
  onboardingMetrics: [
    '[data-testid="parent-selector-onboarding-metrics"]',
    '[data-testid="metametrics-i-agree"]',
  ],
  /** `OnboardingCompletePage.checkPageIsLoaded`. */
  onboardingComplete: [
    '[data-testid="parent-selector-onboarding-complete"]',
    '[data-testid="manage-default-settings"]',
    '[data-testid="onboarding-complete-done"]',
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * `TokensTab.checkPriceChartIsShown` plus `checkPriceChartLoaded`, scoped to
 * the asset page: the token list on the home page carries the same
 * percentage test id, so unscoped it would match before the click.
 *
 * @param assetAddress - The address `checkPriceChartLoaded` is given.
 * @returns The selectors.
 */
export function assetPriceChartDestination(assetAddress: string): string[] {
  return [
    '[data-testid="asset-price-chart"]',
    `[data-testid="parent-selector-asset-details"] [data-testid="token-increase-decrease-percentage-${assetAddress}"]`,
  ];
}
