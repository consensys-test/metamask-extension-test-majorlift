/**
 * Checks for the confirm-tx flow's settle and its long-task line, with the
 * browser, the page objects and the timers replaced by recorders. Each
 * recorder appends to `mockEvents`, so a test can check where the settle ran
 * relative to the probe and the click, and where the long-task line was logged
 * relative to the probe's read.
 */

import type { InPageProbeReading } from '../../utils/in-page-step-timer';
import type { BenchmarkRunResult } from '../../utils/types';

const mockEvents: string[] = [];
const mockFinishCalls: { id: string; harnessReadings: readonly string[] }[] =
  [];
let mockProbeInstalled = true;
let mockReading: unknown = null;
let mockLongTaskData: unknown = null;

/**
 * The text of a selector, or of the locator the flow handed the driver, as
 * the driver recorder logs it.
 *
 * @param locator - What the flow handed the driver.
 * @returns A short name for it.
 */
function mockLocatorName(locator: unknown): string {
  if (typeof locator === 'function') {
    return 'condition';
  }
  if (locator !== null && typeof locator === 'object') {
    const { text } = locator as { text?: string };
    return text ?? '';
  }
  return String(locator ?? '');
}

jest.mock('../../../webdriver/driver', () => ({}));
jest.mock('../../../helpers', () => ({
  withFixtures: jest.fn(
    async (
      _options: unknown,
      callback: (args: unknown) => Promise<void>,
    ): Promise<void> => {
      await callback({
        driver: new Proxy(
          {},
          {
            get: (_target, prop) =>
              prop === 'then'
                ? undefined
                : async (locator: unknown) => {
                    mockEvents.push(
                      `driver.${String(prop)}:${mockLocatorName(locator)}`,
                    );
                    return prop === 'collectLongTaskMetrics'
                      ? mockLongTaskData
                      : undefined;
                  },
          },
        ),
        mockServer: {},
      });
    },
  ),
}));
jest.mock('../../../fixtures/fixture-builder-v2', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ build: () => ({}) })),
}));
jest.mock('../../../page-objects/flows/login.flow', () => ({
  login: jest.fn(async () => {
    mockEvents.push('login');
  }),
}));
jest.mock('../../../page-objects/flows/transaction.flow', () => ({
  createInternalTransaction: jest.fn(async () => {
    mockEvents.push('createInternalTransaction');
  }),
}));
jest.mock('../../utils/long-task-helper', () => ({
  buildLongTaskTimerResults: jest.fn(() => []),
  legacyStepTimerId: (id: string) => `${id}Legacy`,
}));
jest.mock('../../utils/in-page-step-timer', () => ({
  startInPageStep: jest.fn(async (_driver: unknown, id: string) => {
    mockEvents.push(`probe:${id}`);
    return mockProbeInstalled;
  }),
  finishInPageStep: jest.fn(
    async (
      _driver: unknown,
      id: string,
      onReading: (stepReading: unknown) => void,
      harnessReadings: readonly string[],
    ) => {
      mockEvents.push(`read:${id}`);
      mockFinishCalls.push({ id, harnessReadings });
      onReading({ stepId: id, reading: mockReading });
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => undefined),
  runUserActionBenchmark: jest.fn(
    async (
      measure: () => Promise<{ timers: unknown[]; webVitals: unknown }>,
    ) => {
      try {
        return { ...(await measure()), success: true };
      } catch (error) {
        return { timers: [], success: false, error: String(error) };
      }
    },
  ),
}));

// Imported after the mocks above, which jest hoists over it.
// eslint-disable-next-line import-x/first
import {
  CONFIRM_SETTLE_BEFORE_TRIGGER,
  CONFIRM_SETTLE_MS,
  describeConfirmLongTasks,
  run as runConfirmTx,
} from './confirm-tx';

/**
 * Where an event was recorded, failing the test when it was not.
 *
 * @param event - The event to find.
 * @returns Its index in `mockEvents`.
 */
function at(event: string): number {
  const index = mockEvents.indexOf(event);
  if (index === -1) {
    throw new Error(`"${event}" was not recorded: ${mockEvents.join(', ')}`);
  }
  return index;
}

/**
 * A probe reading, with the start at a whole number so that the line's
 * subtractions are exact.
 *
 * @param overrides - The fields that differ from a 150 ms hold at 5000 ms.
 * @returns The reading.
 */
function reading(
  overrides: Partial<InPageProbeReading> = {},
): InPageProbeReading {
  return {
    start: 5000,
    end: 5700,
    startEvent: 'pointerdown',
    preexisting: false,
    extraInputs: 0,
    timedOut: false,
    unobserved: false,
    startTimeStamp: 4999,
    typedKeys: 0,
    lastTypedAt: null,
    typedBeforeTriggerTimeStamp: null,
    typedBeforeTriggerAt: null,
    heldMs: 150,
    longTasksReset: false,
    epochOffset: 0,
    ...overrides,
  };
}

/**
 * The app's long-task metrics, as the page reports them.
 *
 * @param starts - Each task's start on the page's clock, with its duration.
 * @param overrides - The fields that differ from an attached observer that
 * counted the tasks it lists.
 * @returns The metrics.
 */
function longTasks(
  starts: [number, number][],
  overrides: Partial<{ count: number; observed: boolean }> = {},
) {
  return {
    count: starts.length,
    observed: true,
    ...overrides,
    tasks: starts.map(([startTime, duration]) => ({
      name: 'self',
      startTime,
      duration,
    })),
  };
}

const LONG_TASK_LINE = '[benchmark] confirm_tx long tasks';
const LONG_TASK_LABEL = `${LONG_TASK_LINE} (each: start from the probe's start for its duration)`;

describe('confirm-tx flow', () => {
  const original = process.env[CONFIRM_SETTLE_BEFORE_TRIGGER];

  beforeEach(() => {
    mockEvents.length = 0;
    mockFinishCalls.length = 0;
    mockProbeInstalled = true;
    mockReading = reading();
    mockLongTaskData = longTasks([]);
    delete process.env[CONFIRM_SETTLE_BEFORE_TRIGGER];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      mockEvents.push(`log:${args.join(' ')}`);
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) {
      delete process.env[CONFIRM_SETTLE_BEFORE_TRIGGER];
    } else {
      process.env[CONFIRM_SETTLE_BEFORE_TRIGGER] = original;
    }
  });

  async function run(): Promise<BenchmarkRunResult> {
    const result = await runConfirmTx();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  describe('the settle before the trigger', () => {
    it('waits 1200 ms after the Confirm button is clickable and before the probe, the long-task reset and the click, when the switch is 1', async () => {
      process.env[CONFIRM_SETTLE_BEFORE_TRIGGER] = '1';

      await run();

      expect(CONFIRM_SETTLE_MS).toBe(1200);
      expect(
        mockEvents.filter((event) => event.startsWith('driver.delay:')),
      ).toStrictEqual(['driver.delay:1200']);
      expect(at('driver.findClickableElement:Confirm')).toBeLessThan(
        at('driver.delay:1200'),
      );
      expect(at('driver.delay:1200')).toBeLessThan(at('probe:confirm_tx'));
      expect(at('driver.delay:1200')).toBeLessThan(
        at('driver.resetLongTaskMetrics:'),
      );
      expect(at('driver.delay:1200')).toBeLessThan(
        at('driver.clickElement:Confirm'),
      );
    });

    it('prints the settle in the readings line, through the harness readings', async () => {
      process.env[CONFIRM_SETTLE_BEFORE_TRIGGER] = '1';

      await run();

      expect(mockFinishCalls).toStrictEqual([
        {
          id: 'confirm_tx',
          harnessReadings: ['settled 1200 ms before the trigger'],
        },
      ]);
    });

    it('does not wait, and prints no settle, when the switch is unset', async () => {
      await run();

      expect(
        mockEvents.filter((event) => event.startsWith('driver.delay')),
      ).toStrictEqual([]);
      expect(mockFinishCalls).toStrictEqual([
        { id: 'confirm_tx', harnessReadings: [] },
      ]);
    });

    // @ts-expect-error '.each' is missing from type definitions
    it.each(['0', '', 'true'])(
      'does not wait, and prints no settle, when the switch is %p',
      async (value: string) => {
        process.env[CONFIRM_SETTLE_BEFORE_TRIGGER] = value;

        await run();

        expect(
          mockEvents.filter((event) => event.startsWith('driver.delay')),
        ).toStrictEqual([]);
        expect(mockFinishCalls).toStrictEqual([
          { id: 'confirm_tx', harnessReadings: [] },
        ]);
      },
    );

    it('leaves the order of the flow without the settle as it was', async () => {
      await run();

      expect(
        mockEvents.filter((event) => !event.startsWith('log:')),
      ).toStrictEqual([
        'login',
        'driver.clickElement:[data-testid="account-overview__activity-tab"]',
        'createInternalTransaction',
        'driver.findClickableElement:Confirm',
        'probe:confirm_tx',
        'driver.resetLongTaskMetrics:',
        'driver.clickElement:Confirm',
        'driver.wait:condition',
        'driver.waitForSelector:[data-tx-status="confirmed"]',
        'driver.collectLongTaskMetrics:',
        'read:confirm_tx',
      ]);
    });
  });

  describe('the long-task line in the flow', () => {
    it('logs one line per iteration, after the probe is read, from the tasks the page collected and the probe start it read', async () => {
      mockReading = reading({ start: 5000, heldMs: 150 });
      mockLongTaskData = longTasks([
        [4999.5, 158],
        [5154.5, 120],
        [5352.5, 215],
      ]);

      await run();

      const lines = mockEvents.filter((event) =>
        event.startsWith(`log:${LONG_TASK_LINE}`),
      );
      expect(lines).toStrictEqual([
        `log:${LONG_TASK_LABEL}: -0.5 ms for 158.0 ms; +154.5 ms for 120.0 ms; +352.5 ms for 215.0 ms. FLAGGED: +154.5 ms for 120.0 ms starts 4.5 ms after the hold's end, within 10 ms`,
      ]);
      expect(at('driver.collectLongTaskMetrics:')).toBeLessThan(
        at('read:confirm_tx'),
      );
      expect(at('read:confirm_tx')).toBeLessThan(mockEvents.indexOf(lines[0]));
    });

    it('says the line is absent, and why, when the probe was not installed', async () => {
      mockProbeInstalled = false;

      await run();

      expect(mockFinishCalls).toStrictEqual([]);
      expect(
        mockEvents.filter((event) => event.startsWith(`log:${LONG_TASK_LINE}`)),
      ).toStrictEqual([
        `log:${LONG_TASK_LINE} absent: the probe has no start to measure from`,
      ]);
    });
  });
});

describe('describeConfirmLongTasks', () => {
  it("lists each task's start from the probe's start, signed, with its duration, and flags none when none starts near the hold's end", () => {
    expect(
      describeConfirmLongTasks(
        longTasks([
          [4999.5, 158],
          [5352.5, 215],
        ]),
        reading(),
      ),
    ).toBe(`${LONG_TASK_LABEL}: -0.5 ms for 158.0 ms; +352.5 ms for 215.0 ms`);
  });

  it("flags a task that starts less than 10 ms after the hold's end, and names how long after", () => {
    expect(
      describeConfirmLongTasks(longTasks([[5154.5, 120]]), reading()),
    ).toBe(
      `${LONG_TASK_LABEL}: +154.5 ms for 120.0 ms. FLAGGED: +154.5 ms for 120.0 ms starts 4.5 ms after the hold's end, within 10 ms`,
    );
  });

  it("flags from the hold's end up to, and not including, 10 ms after it", () => {
    // The hold ends at +150 ms.
    const flagged = (startTime: number) =>
      describeConfirmLongTasks(
        longTasks([[startTime, 80]]),
        reading(),
      ).includes('FLAGGED');

    expect(flagged(5149.5)).toBe(false);
    expect(flagged(5150)).toBe(true);
    expect(flagged(5159.5)).toBe(true);
    expect(flagged(5160)).toBe(false);
  });

  it('does not flag the task that carries the hold itself', () => {
    expect(
      describeConfirmLongTasks(longTasks([[4999.5, 158]]), reading()),
    ).not.toContain('FLAGGED');
  });

  it('measures from the trigger, and says so, where no hold ran', () => {
    expect(
      describeConfirmLongTasks(
        longTasks([[5003, 120]]),
        reading({ heldMs: 0 }),
      ),
    ).toBe(
      `${LONG_TASK_LABEL}: +3.0 ms for 120.0 ms. FLAGGED: +3.0 ms for 120.0 ms starts 3.0 ms after the trigger, within 10 ms`,
    );
  });

  it('says none, and does not leave the list empty, when the observer attached and saw no long task', () => {
    expect(describeConfirmLongTasks(longTasks([]), reading())).toBe(
      `${LONG_TASK_LABEL}: none`,
    );
  });

  it('says how many of the tasks it lists when the app counted more than it kept', () => {
    expect(
      describeConfirmLongTasks(
        longTasks([[5352.5, 215]], { count: 63 }),
        reading(),
      ),
    ).toBe(`${LONG_TASK_LABEL}: +352.5 ms for 215.0 ms (listed 1 of 63)`);
  });

  // @ts-expect-error '.each' is missing from type definitions
  it.each([
    [
      'the probe was lost',
      null,
      longTasks([]),
      'the probe has no start to measure from',
    ],
    [
      'no trusted input reached the trigger',
      reading({ start: null }),
      longTasks([]),
      'the probe has no start to measure from',
    ],
    [
      'the page had no long-task hook',
      reading(),
      null,
      'the app reported no observed long-task data',
    ],
    [
      'the observer did not attach',
      reading(),
      longTasks([], { observed: false }),
      'the app reported no observed long-task data',
    ],
  ])(
    'says the line is absent, never none, when %s',
    (
      _case: string,
      probeReading: InPageProbeReading | null,
      data: ReturnType<typeof longTasks> | null,
      reason: string,
    ) => {
      expect(describeConfirmLongTasks(data, probeReading)).toBe(
        `${LONG_TASK_LINE} absent: ${reason}`,
      );
    },
  );
});
