/**
 * Order and naming checks for the import-SRP-from-home flow, with the browser,
 * the page objects and the timers replaced by recorders. Each recorder appends
 * to `mockEvents`, so a test can check where a wait ran relative to the probe
 * and the step timer of the step it precedes.
 */

import type { BenchmarkRunResult } from '../../utils/types';

const mockEvents: string[] = [];
const mockQuietCalls: unknown[][] = [];
const mockHarnessReadings: Record<string, readonly string[]> = {};
const mockClickLagAsked: string[] = [];
let mockQuietFailure: Error | undefined;

/**
 * A page-object class whose instances record every method called on them.
 *
 * @param label - The class name to record calls under.
 * @returns The mocked class.
 */
function mockPageObject(label: string) {
  return jest.fn().mockImplementation(
    () =>
      new Proxy(
        {},
        {
          get: (_target, prop) =>
            prop === 'then'
              ? undefined
              : async () => {
                  mockEvents.push(`${label}.${String(prop)}`);
                },
        },
      ),
  );
}

/**
 * A module whose default export is `value`, as `jest.mock` factories return
 * one for an ES module.
 *
 * @param value - The default export.
 * @returns The module.
 */
function mockDefaultModule(value: unknown) {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  return { __esModule: true, default: value };
}

jest.mock('../../../webdriver/driver', () => ({}));
jest.mock('../../../helpers', () => ({
  withFixtures: jest.fn(
    async (
      _options: unknown,
      callback: (args: unknown) => Promise<void>,
    ): Promise<void> => {
      await callback({
        driver: new Proxy({}, { get: () => async () => undefined }),
        mockedEndpoint: [],
        mockServer: {},
      });
    },
  ),
}));
jest.mock('../../../../../app/scripts/fixtures/generate-wallet-state', () => ({
  generateWalletState: jest.fn(async () => ({
    withEnabledNetworks: () => ({ build: () => ({}) }),
  })),
}));
jest.mock('../../../../../app/scripts/fixtures/with-networks', () => ({
  ALL_POPULAR_NETWORKS: {},
}));
jest.mock('../../../page-objects/pages/accounts/list-page', () =>
  mockDefaultModule(mockPageObject('AccountListPage')),
);
jest.mock('../../../page-objects/pages/home/tokens-tab', () =>
  mockDefaultModule(mockPageObject('TokensTab')),
);
jest.mock('../../../page-objects/pages/home/homepage', () =>
  mockDefaultModule(mockPageObject('HomePage')),
);
// `loginToHomepage` types, runs `beforeSubmit` when given, then clicks Unlock,
// as the page object does.
jest.mock('../../../page-objects/pages/onboarding/login-page', () =>
  mockDefaultModule(
    jest.fn().mockImplementation(
      () =>
        new Proxy(
          {},
          {
            get: (_target, prop) => {
              if (prop === 'then') {
                return undefined;
              }
              if (prop === 'loginToHomepage') {
                return async (
                  _password?: string,
                  options?: { beforeSubmit?: () => Promise<void> },
                ) => {
                  mockEvents.push('LoginPage.typePassword');
                  if (options?.beforeSubmit) {
                    await options.beforeSubmit();
                  }
                  mockEvents.push('LoginPage.clickUnlock');
                };
              }
              return async () => {
                mockEvents.push(`LoginPage.${String(prop)}`);
              };
            },
          },
        ),
    ),
  ),
);
// Each step timer is reported as its step id plus `Legacy`, as
// `measureStepWithLongTasks` names it, and each in-page timer as its step id.
jest.mock('../../utils/timer-helper', () => ({
  collectTimerResults: jest.fn(() =>
    mockEvents
      .filter((event) => event.startsWith('timer:'))
      .map((event) => ({
        id: `${event.slice('timer:'.length)}Legacy`,
        value: 1,
      })),
  ),
}));
jest.mock('../../utils/long-task-helper', () => ({
  measureStepWithLongTasks: jest.fn(
    async (_driver: unknown, id: string, action: () => Promise<void>) => {
      mockEvents.push(`timer:${id}`);
      await action();
      mockEvents.push(`timerEnd:${id}`);
      return { id };
    },
  ),
  buildLongTaskTimerResults: jest.fn(() => []),
}));
jest.mock('../../utils/in-page-step-timer', () => ({
  IN_PAGE_DESTINATIONS: new Proxy({}, { get: (_target, prop) => [prop] }),
  startInPageStep: jest.fn(
    async (
      _driver: unknown,
      id: string,
      options: {
        recordTypingBeforeTrigger?: boolean;
        recordClickLag?: boolean;
      },
    ) => {
      mockEvents.push(`probe:${id}`);
      if (options.recordTypingBeforeTrigger) {
        mockEvents.push(`recordTypingBeforeTrigger:${id}`);
      }
      if (options.recordClickLag) {
        mockClickLagAsked.push(id);
      }
      return true;
    },
  ),
  finishInPageStep: jest.fn(
    async (
      _driver: unknown,
      id: string,
      onReading?: (stepReading: unknown) => void,
      harnessReadings: readonly string[] = [],
    ) => {
      mockEvents.push(`read:${id}`);
      mockHarnessReadings[id] = harnessReadings;
      onReading?.({ stepId: id, reading: null });
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
  logRequestsWithinInPageSteps: jest.fn(
    async (_mockServer: unknown, steps: { stepId: string }[]) => {
      mockEvents.push(
        `requestLog:${steps.map((step) => step.stepId).join(',')}`,
      );
    },
  ),
  measureStepInPage: jest.fn(
    async (
      _driver: unknown,
      id: string,
      {
        trigger,
        settle,
        onReading,
        recordTypingBeforeTrigger,
        recordClickLag,
      }: {
        trigger: () => Promise<void>;
        settle: () => Promise<void>;
        onReading?: (stepReading: unknown) => void;
        recordTypingBeforeTrigger?: boolean;
        recordClickLag?: boolean;
      },
    ) => {
      mockEvents.push(`probe:${id}`);
      if (recordTypingBeforeTrigger) {
        mockEvents.push(`recordTypingBeforeTrigger:${id}`);
      }
      if (recordClickLag) {
        mockClickLagAsked.push(id);
      }
      await trigger();
      await settle();
      onReading?.({ stepId: id, reading: null });
      mockEvents.push(`read:${id}`);
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
}));
jest.mock('../../utils/mock-config', () => ({
  getTestSpecificMock: jest.fn(),
  shouldUseMockedRequests: jest.fn(() => true),
}));
jest.mock('../../utils/sidepanel-onboarding', () => ({
  waitForPageIdleBeforeStep: jest.fn(async () => {
    mockEvents.push('pageIdle');
  }),
  waitForAccountSyncIdleBeforeStep: jest.fn(async () => {
    mockEvents.push('accountSyncIdle');
  }),
}));
// The switch names are the module's own; each wait records that it ran.
jest.mock('../../utils/trigger-quiet', () => ({
  LOGIN_POINTER_BEFORE_TRIGGER: 'BENCHMARK_LOGIN_POINTER_BEFORE_TRIGGER',
  LOGIN_PAGE_IDLE_BEFORE_TRIGGER: 'BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER',
  LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER:
    'BENCHMARK_LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER',
  movePointerOnto: jest.fn(
    async (_driver: unknown, selector: string, holdMs: number) => {
      mockEvents.push(`pointer:${selector}:${holdMs}`);
      return 'pointer reading';
    },
  ),
  waitForTriggerQuiet: jest.fn(
    async (_driver: unknown, id: string, parts: Record<string, unknown>) => {
      mockEvents.push(`quiet:${id}:${Object.keys(parts).sort().join('+')}`);
      mockQuietCalls.push([id, parts]);
      if (mockQuietFailure) {
        throw mockQuietFailure;
      }
      return Object.keys(parts).map((part) => `${part} reading`);
    },
  ),
}));
jest.mock('../../utils/sentry-transactions', () => ({
  waitForSentryTransactions: jest.fn(async () => []),
  sentryTimerResult: jest.fn((_transactions: unknown, _name: unknown, id) => ({
    id,
    value: 1,
    unit: 'ms',
  })),
  sentryCountResult: jest.fn((_transactions: unknown, _name: unknown, id) => ({
    id,
    value: 1,
    unit: 'count',
  })),
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => undefined),
}));

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

describe('runImportSrpHomeBenchmark', () => {
  const originalSrp = process.env.TEST_SRP_2;
  const loginSwitches = [
    'BENCHMARK_LOGIN_POINTER_BEFORE_TRIGGER',
    'BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER',
    'BENCHMARK_LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER',
  ];

  beforeEach(() => {
    mockEvents.length = 0;
    mockQuietCalls.length = 0;
    mockClickLagAsked.length = 0;
    mockQuietFailure = undefined;
    for (const id of Object.keys(mockHarnessReadings)) {
      delete mockHarnessReadings[id];
    }
    process.env.TEST_SRP_2 = 'test test test';
  });
  afterEach(() => {
    for (const name of loginSwitches) {
      delete process.env[name];
    }
    if (originalSrp === undefined) {
      delete process.env.TEST_SRP_2;
    } else {
      process.env.TEST_SRP_2 = originalSrp;
    }
  });

  async function runFlow(): Promise<BenchmarkRunResult> {
    let flow: typeof import('./import-srp-home') | undefined;
    jest.isolateModules(() => {
      // The flow reads `TEST_SRP_2` when the module loads.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      flow = require('./import-srp-home');
    });
    return await (
      flow as typeof import('./import-srp-home')
    ).runImportSrpHomeBenchmark();
  }

  async function run(): Promise<BenchmarkRunResult> {
    const result = await runFlow();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  /** The login step's events from the typing to the click. */
  function betweenTypingAndUnlock(): string[] {
    return mockEvents.slice(
      at('LoginPage.typePassword'),
      at('LoginPage.clickUnlock') + 1,
    );
  }

  it('waits for the page to go idle before the login probe and its step timer', async () => {
    await run();

    expect(mockEvents.filter((event) => event === 'pageIdle')).toHaveLength(1);
    expect(at('LoginPage.checkPageIsLoaded')).toBeLessThan(at('pageIdle'));
    expect(at('pageIdle')).toBeLessThan(at('probe:loginToHomeScreen'));
    expect(at('pageIdle')).toBeLessThan(at('timer:loginToHomeScreen'));
  });

  it('waits for account syncing before the account-list probe, after the login step', async () => {
    await run();

    expect(
      mockEvents.filter((event) => event === 'accountSyncIdle'),
    ).toHaveLength(1);
    expect(at('read:loginToHomeScreen')).toBeLessThan(at('accountSyncIdle'));
    expect(at('accountSyncIdle')).toBeLessThan(
      at('probe:openAccountMenuAfterLogin'),
    );
  });

  it('asks the login probe, and only it, to record the typing before the Unlock click', async () => {
    await run();

    expect(
      mockEvents.filter((event) =>
        event.startsWith('recordTypingBeforeTrigger:'),
      ),
    ).toStrictEqual(['recordTypingBeforeTrigger:loginToHomeScreen']);
  });

  describe('the waits between typing the password and clicking Unlock', () => {
    it('runs none, and passes no hook, when every login switch is unset', async () => {
      await run();

      expect(betweenTypingAndUnlock()).toStrictEqual([
        'LoginPage.typePassword',
        'LoginPage.clickUnlock',
      ]);
      expect(mockQuietCalls).toStrictEqual([]);
      expect(mockHarnessReadings.loginToHomeScreen).toStrictEqual([]);
    });

    it('runs none when the switches are 0', async () => {
      for (const name of loginSwitches) {
        process.env[name] = '0';
      }

      await run();

      expect(betweenTypingAndUnlock()).toStrictEqual([
        'LoginPage.typePassword',
        'LoginPage.clickUnlock',
      ]);
    });

    it('with the pointer switch alone, moves the pointer onto Unlock and holds it 300 ms, and runs no part', async () => {
      process.env.BENCHMARK_LOGIN_POINTER_BEFORE_TRIGGER = '1';

      await run();

      expect(betweenTypingAndUnlock()).toStrictEqual([
        'LoginPage.typePassword',
        'pointer:[data-testid="unlock-submit"]:300',
        'LoginPage.clickUnlock',
      ]);
      expect(mockHarnessReadings.loginToHomeScreen).toStrictEqual([
        'pointer reading',
      ]);
    });

    it("with the page switch alone, runs the page part with d9's heartbeat, two idle periods and a 5 s cap", async () => {
      process.env.BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER = '1';

      await run();

      expect(betweenTypingAndUnlock()).toStrictEqual([
        'LoginPage.typePassword',
        'quiet:loginToHomeScreen:page',
        'LoginPage.clickUnlock',
      ]);
      expect(mockQuietCalls).toStrictEqual([
        [
          'loginToHomeScreen',
          {
            page: {
              idlePeriods: 2,
              heartbeat: { windowMs: 250, stallMs: 8 },
              capMs: 5_000,
            },
          },
        ],
      ]);
      expect(mockHarnessReadings.loginToHomeScreen).toStrictEqual([
        'page reading',
      ]);
    });

    it('with the pointer and page switches, moves the pointer, then waits, then clicks', async () => {
      process.env.BENCHMARK_LOGIN_POINTER_BEFORE_TRIGGER = '1';
      process.env.BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER = '1';

      await run();

      expect(betweenTypingAndUnlock()).toStrictEqual([
        'LoginPage.typePassword',
        'pointer:[data-testid="unlock-submit"]:300',
        'quiet:loginToHomeScreen:page',
        'LoginPage.clickUnlock',
      ]);
      // Both readings reach the login step's readings line, in that order.
      expect(mockHarnessReadings.loginToHomeScreen).toStrictEqual([
        'pointer reading',
        'page reading',
      ]);
    });

    it('with the background switch, adds the background part with its thresholds', async () => {
      process.env.BENCHMARK_LOGIN_BACKGROUND_IDLE_BEFORE_TRIGGER = '1';
      process.env.BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER = '1';

      await run();

      expect(mockQuietCalls).toHaveLength(1);
      expect(mockQuietCalls[0][1]).toMatchObject({
        background: { windowMs: 250, answerMs: 5, capMs: 5_000 },
        page: { idlePeriods: 2 },
      });
    });

    it('runs inside the login step timer and after its probe, outside the in-page interval', async () => {
      process.env.BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER = '1';

      await run();

      expect(at('probe:loginToHomeScreen')).toBeLessThan(
        at('timer:loginToHomeScreen'),
      );
      expect(at('timer:loginToHomeScreen')).toBeLessThan(
        at('quiet:loginToHomeScreen:page'),
      );
      expect(at('quiet:loginToHomeScreen:page')).toBeLessThan(
        at('timerEnd:loginToHomeScreen'),
      );
    });

    it('fails the iteration, without clicking Unlock, when a wait fails', async () => {
      process.env.BENCHMARK_LOGIN_PAGE_IDLE_BEFORE_TRIGGER = '1';
      mockQuietFailure = new Error('trigger-quiet page capped at 5000.0 ms');

      const result = await runFlow();

      expect(result.success).toBe(false);
      expect(result.error).toBe('trigger-quiet page capped at 5000.0 ms');
      expect(mockEvents).not.toContain('LoginPage.clickUnlock');
    });
  });

  it('asks the login probe, and only it, to record the click lag', async () => {
    await run();

    expect(mockClickLagAsked).toStrictEqual(['loginToHomeScreen']);
  });

  it("logs the mock server's requests within every in-page step once, after everything measured", async () => {
    await run();

    expect(
      mockEvents.filter((event) => event.startsWith('requestLog:')),
    ).toStrictEqual([
      'requestLog:loginToHomeScreen,openAccountMenuAfterLogin,homeAfterImportWithNewWallet',
    ]);
    expect(mockEvents[mockEvents.length - 1]).toMatch(/^requestLog:/u);
  });

  it('reports each series under one name, every step timer as its step id plus Legacy', async () => {
    const result = await run();

    const ids = result.timers.map((timer) => timer.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toStrictEqual(
      expect.arrayContaining([
        'loginToHomeScreenLegacy',
        'loginToHomeScreen',
        'openAccountMenuAfterLoginLegacy',
        'openAccountMenuAfterLogin',
        'homeAfterImportWithNewWalletLegacy',
        'homeAfterImportWithNewWallet',
      ]),
    );
  });

  it('reports the Show Account List count beside its duration', async () => {
    const result = await run();

    expect(
      result.timers.filter((timer) => timer.id.startsWith('showAccountList')),
    ).toStrictEqual([
      { id: 'showAccountList', value: 1, unit: 'ms' },
      { id: 'showAccountListCount', value: 1, unit: 'count' },
    ]);
  });
});

describe('LoginPage.loginToHomepage', () => {
  // The page object itself, not the recorder the flow tests use.
  const { default: RealLoginPage } = jest.requireActual<{
    default: typeof import('../../../page-objects/pages/onboarding/login-page').default;
  }>('../../../page-objects/pages/onboarding/login-page');

  function recordingDriver(order: string[]) {
    return {
      fill: jest.fn(async () => {
        order.push('fill');
      }),
      clickElement: jest.fn(async () => {
        order.push('click');
      }),
    } as unknown as ConstructorParameters<typeof RealLoginPage>[0];
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('types the password and clicks Unlock, as before, without a hook', async () => {
    const order: string[] = [];

    await new RealLoginPage(recordingDriver(order)).loginToHomepage();

    expect(order).toStrictEqual(['fill', 'click']);
  });

  it('runs `beforeSubmit` after the typing and before the Unlock click', async () => {
    const order: string[] = [];

    await new RealLoginPage(recordingDriver(order)).loginToHomepage(undefined, {
      beforeSubmit: async () => {
        order.push('beforeSubmit');
      },
    });

    expect(order).toStrictEqual(['fill', 'beforeSubmit', 'click']);
  });
});
