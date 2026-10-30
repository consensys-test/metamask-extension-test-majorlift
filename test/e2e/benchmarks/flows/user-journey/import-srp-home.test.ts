/**
 * Order and naming checks for the import-SRP-from-home flow, with the browser,
 * the page objects and the timers replaced by recorders. Each recorder appends
 * to `mockEvents`, so a test can check where a wait ran relative to the probe
 * and the step timer of the step it precedes.
 */

import type { BenchmarkRunResult } from '../../utils/types';

const mockEvents: string[] = [];

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
jest.mock('../../../page-objects/pages/onboarding/login-page', () =>
  mockDefaultModule(mockPageObject('LoginPage')),
);
jest.mock('../../utils/timer-helper', () => ({
  collectTimerResults: jest.fn(() =>
    mockEvents
      .filter((event) => event.startsWith('timer:'))
      .map((event) => ({ id: event.slice('timer:'.length), value: 1 })),
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
  startInPageStep: jest.fn(async (_driver: unknown, id: string) => {
    mockEvents.push(`probe:${id}`);
    return true;
  }),
  finishInPageStep: jest.fn(async (_driver: unknown, id: string) => {
    mockEvents.push(`read:${id}`);
    return [{ id: `${id}InPage`, value: 1, unit: 'ms' }];
  }),
  measureStepInPage: jest.fn(
    async (
      _driver: unknown,
      id: string,
      {
        trigger,
        settle,
      }: { trigger: () => Promise<void>; settle: () => Promise<void> },
    ) => {
      mockEvents.push(`probe:${id}`);
      await trigger();
      await settle();
      mockEvents.push(`read:${id}`);
      return [{ id: `${id}InPage`, value: 1, unit: 'ms' }];
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

  beforeEach(() => {
    mockEvents.length = 0;
    process.env.TEST_SRP_2 = 'test test test';
  });
  afterEach(() => {
    if (originalSrp === undefined) {
      delete process.env.TEST_SRP_2;
    } else {
      process.env.TEST_SRP_2 = originalSrp;
    }
  });

  async function run(): Promise<BenchmarkRunResult> {
    let flow: typeof import('./import-srp-home') | undefined;
    jest.isolateModules(() => {
      // The flow reads `TEST_SRP_2` when the module loads.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      flow = require('./import-srp-home');
    });
    const result = await (
      flow as typeof import('./import-srp-home')
    ).runImportSrpHomeBenchmark();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
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
