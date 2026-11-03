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
const mockQuietCalls: unknown[][] = [];
const mockTrafficTracked = { tracked: 'traffic' };
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
  login: jest.fn(async () => {
    mockEvents.push('login');
  }),
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
        readBeforeTrigger,
      }: {
        trigger: () => Promise<void>;
        settle: () => Promise<void>;
        onReading?: (stepReading: unknown) => void;
        readBeforeTrigger?: () => Promise<readonly string[]>;
      },
    ) => {
      mockEvents.push(`probe:${id}`);
      if (readBeforeTrigger) {
        mockEvents.push(`readBeforeTrigger:${id}`);
        mockEvents.push(
          ...(await readBeforeTrigger()).map((part) => `reading:${part}`),
        );
      }
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
// The switch name is the module's own; each wait records that it ran.
jest.mock('../../utils/trigger-quiet', () => ({
  REVIEW_MOCK_QUIET_BEFORE_STEP: 'BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP',
  trackMockTraffic: jest.fn(async (mockServer: unknown) => {
    mockEvents.push('trackMockTraffic');
    mockQuietCalls.push(['track', mockServer]);
    return mockTrafficTracked;
  }),
  waitForTriggerQuiet: jest.fn(
    async (_driver: unknown, id: string, parts: Record<string, unknown>) => {
      mockEvents.push(`quiet:${id}`);
      mockQuietCalls.push([id, parts]);
      if (mockQuietFailure) {
        throw mockQuietFailure;
      }
      return Object.keys(parts).map((part) => `${part} reading`);
    },
  ),
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
    mockQuietCalls.length = 0;
    mockQuietFailure = undefined;
  });
  afterEach(() => {
    delete process.env.BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP;
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

  describe('the wait before the review step', () => {
    it('adds no listener and no wait when the switch is unset or 0', async () => {
      await run();
      process.env.BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP = '0';
      await run();

      expect(mockEvents).not.toContain('trackMockTraffic');
      expect(
        mockEvents.filter((event) => event.startsWith('readBeforeTrigger:')),
      ).toStrictEqual([]);
      expect(mockQuietCalls).toStrictEqual([]);
    });

    it('with the switch set, tracks the traffic from before login and waits after the amount, before the probe', async () => {
      process.env.BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP = '1';

      await run();

      expect(at('trackMockTraffic')).toBeLessThan(at('login'));
      expect(at('SendPage.fillAmount')).toBeLessThan(
        at('quiet:reviewTransactionToConfirmationPage'),
      );
      expect(at('quiet:reviewTransactionToConfirmationPage')).toBeLessThan(
        at('probe:reviewTransactionToConfirmationPage'),
      );
      // The mock part alone, Q 500 ms, capped at 10 s, on the tracked traffic.
      expect(mockQuietCalls).toStrictEqual([
        ['track', mockMockServer],
        [
          'reviewTransactionToConfirmationPage',
          {
            mock: { traffic: mockTrafficTracked, quietMs: 500, capMs: 10_000 },
          },
        ],
      ]);
      // Its reading goes to the review step's readings line, and only there.
      expect(
        mockEvents.filter((event) => event.startsWith('readBeforeTrigger:')),
      ).toStrictEqual([
        'readBeforeTrigger:reviewTransactionToConfirmationPage',
      ]);
      expect(mockEvents).toContain('reading:mock reading');
    });

    it('fails the iteration, without the review step, when the wait fails', async () => {
      process.env.BENCHMARK_REVIEW_MOCK_QUIET_BEFORE_STEP = '1';
      mockQuietFailure = new Error('trigger-quiet mock capped at 10000 ms');

      const result = await runSendTransactionsBenchmark();

      expect(result.success).toBe(false);
      expect(result.error).toBe('trigger-quiet mock capped at 10000 ms');
      expect(mockEvents).not.toContain(
        'probe:reviewTransactionToConfirmationPage',
      );
    });
  });
});
