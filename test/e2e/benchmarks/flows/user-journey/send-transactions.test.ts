/**
 * Request-log checks for the send flow, with the browser, the page objects
 * and the timers replaced by recorders. Each recorder appends to
 * `mockEvents`, so a test can check when the log is read relative to the
 * steps it describes.
 */

import type { BenchmarkRunResult } from '../../utils/types';

const mockEvents: string[] = [];
const mockMockServer = { name: 'the iteration mock server' };
const mockRequestLogCalls: unknown[][] = [];

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
        mockServer: mockMockServer,
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
  login: jest.fn(async () => undefined),
}));
jest.mock('../../../page-objects/pages/accounts/list-page', () =>
  mockDefaultModule(mockPageObject('AccountListPage')),
);
jest.mock('../../../page-objects/pages/home/header-navbar', () =>
  mockDefaultModule(mockPageObject('HeaderNavbar')),
);
jest.mock('../../../page-objects/pages/home/tokens-tab', () =>
  mockDefaultModule(mockPageObject('TokensTab')),
);
jest.mock(
  '../../../page-objects/pages/confirmations/snap-transaction-confirmation',
  () => mockDefaultModule(mockPageObject('SnapTransactionConfirmation')),
);
jest.mock('../../../page-objects/pages/home/homepage', () =>
  mockDefaultModule(mockPageObject('HomePage')),
);
jest.mock('../../../page-objects/pages/send/send-page', () =>
  mockDefaultModule(mockPageObject('SendPage')),
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
  logRequestsWithinInPageSteps: jest.fn(async (...args: unknown[]) => {
    mockEvents.push('requestLog');
    mockRequestLogCalls.push(args);
  }),
  measureStepInPage: jest.fn(
    async (
      _driver: unknown,
      id: string,
      {
        trigger,
        settle,
        onReading,
      }: {
        trigger: () => Promise<void>;
        settle: () => Promise<void>;
        onReading?: (stepReading: unknown) => void;
      },
    ) => {
      mockEvents.push(`probe:${id}`);
      await trigger();
      await settle();
      onReading?.({ stepId: id, reading: null });
      mockEvents.push(`read:${id}`);
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
}));
jest.mock('../../utils/optional-dialog', () => ({
  waitDismissingOptionalDialog: jest.fn(async () => false),
}));
jest.mock('../../utils/mock-config', () => ({
  getTestSpecificMock: jest.fn(),
  shouldUseMockedRequests: jest.fn(() => true),
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => {
    mockEvents.push('webVitals');
    return {};
  }),
}));

// Imported after the mocks above, which jest hoists over it.
// eslint-disable-next-line import-x/first
import { runSendTransactionsBenchmark } from './send-transactions';

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

describe('runSendTransactionsBenchmark', () => {
  beforeEach(() => {
    mockEvents.length = 0;
    mockRequestLogCalls.length = 0;
  });

  async function run(): Promise<BenchmarkRunResult> {
    const result = await runSendTransactionsBenchmark();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  it("logs the mock server's requests within each in-page step once, after every step and web vitals", async () => {
    await run();

    expect(mockRequestLogCalls).toStrictEqual([
      [
        mockMockServer,
        [
          { stepId: 'openSendPageFromHome', reading: null },
          { stepId: 'selectTokenToSendFormLoaded', reading: null },
          { stepId: 'reviewTransactionToConfirmationPage', reading: null },
        ],
      ],
    ]);
    expect(at('timerEnd:reviewTransactionToConfirmationPage')).toBeLessThan(
      at('webVitals'),
    );
    expect(at('webVitals')).toBeLessThan(at('requestLog'));
  });
});
