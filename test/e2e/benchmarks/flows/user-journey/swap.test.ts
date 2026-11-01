/**
 * Order checks for the swap flow, with the browser, the page objects and the
 * timers replaced by recorders. Each recorder appends to `mockEvents`, so a
 * test can check where a wait ran relative to the probe and the step timer of
 * the step it precedes.
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
jest.mock('../../../page-objects/flows/login.flow', () => ({
  login: jest.fn(async () => {
    mockEvents.push('login');
  }),
}));
jest.mock('../../../page-objects/pages/home/tokens-tab', () =>
  mockDefaultModule(mockPageObject('TokensTab')),
);
jest.mock('../../../page-objects/pages/home/homepage', () =>
  mockDefaultModule(mockPageObject('HomePage')),
);
jest.mock('../../../page-objects/pages/swap/swap-page', () =>
  mockDefaultModule(mockPageObject('SwapPage')),
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
  logRequestsWithinInPageSteps: jest.fn(async () => {
    mockEvents.push('requestLog');
  }),
  measureStepInPage: jest.fn(
    async (
      _driver: unknown,
      id: string,
      {
        trigger,
        settle,
      }: {
        trigger: () => Promise<void>;
        settle: (probe: { installed: boolean }) => Promise<void>;
      },
    ) => {
      mockEvents.push(`probe:${id}`);
      await trigger();
      await settle({ installed: true });
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
}));
jest.mock('../../utils/sentry-transactions', () => ({
  waitForSentryTransactions: jest.fn(async () => []),
  sentryTimerResult: jest.fn((_transactions: unknown, _name: unknown, id) => ({
    id,
    value: 1,
    unit: 'ms',
  })),
  sentryInitialTimerResult: jest.fn(
    (_transactions: unknown, _name: unknown, id) => ({
      id,
      value: 1,
      unit: 'ms',
    }),
  ),
  sentryCountResult: jest.fn((_transactions: unknown, _name: unknown, id) => ({
    id,
    value: 1,
    unit: 'count',
  })),
}));
jest.mock('../../mocks/swap-mocks', () => ({
  registerSwapInterceptor: jest.fn(),
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => undefined),
}));

// Imported after the mocks above, which jest hoists over it.
// eslint-disable-next-line import-x/first
import { runSwapBenchmark } from './swap';

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

describe('runSwapBenchmark', () => {
  beforeEach(() => {
    mockEvents.length = 0;
  });

  async function run(): Promise<BenchmarkRunResult> {
    const result = await runSwapBenchmark();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  it('waits for the page to go idle once, after the balance check and before the swap-page probe and its step timer', async () => {
    await run();

    expect(mockEvents.filter((event) => event === 'pageIdle')).toHaveLength(1);
    expect(at('TokensTab.checkTokenAmountIsDisplayed')).toBeLessThan(
      at('pageIdle'),
    );
    expect(at('pageIdle')).toBeLessThan(at('probe:openSwapPageFromHome'));
    expect(at('pageIdle')).toBeLessThan(at('timer:openSwapPageFromHome'));
  });
});
