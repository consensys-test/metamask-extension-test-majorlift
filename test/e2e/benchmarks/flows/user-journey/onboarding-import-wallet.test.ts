/**
 * Naming and order checks for the import-wallet onboarding flow, with the
 * browser, the page objects and the timers replaced by recorders. Each
 * recorder appends to `mockEvents`, so a test can read which series a run
 * names and where a wait ran relative to the step it precedes.
 */
import type { BenchmarkRunResult } from '../../utils/types';

const mockEvents: string[] = [];
const mockFixtureOptions: Record<string, unknown>[] = [];

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

jest.mock('selenium-webdriver', () => ({ Browser: { FIREFOX: 'firefox' } }));
jest.mock('../../../webdriver/driver', () => ({}));
jest.mock('../../../helpers', () => ({
  withFixtures: jest.fn(
    async (
      options: Record<string, unknown>,
      callback: (args: unknown) => Promise<void>,
    ): Promise<void> => {
      mockFixtureOptions.push(options);
      await callback({
        driver: new Proxy({}, { get: () => async () => undefined }),
        mockedEndpoint: [],
      });
    },
  ),
}));
jest.mock('../../../fixtures/fixture-builder-v2', () =>
  mockDefaultModule(
    jest.fn().mockImplementation(() => ({
      withEnabledNetworks: () => ({ build: () => ({}) }),
    })),
  ),
);
jest.mock('../../../constants', () => ({
  E2E_SRP: 'test test test',
  WALLET_PASSWORD: 'password',
}));
jest.mock('../../../../../app/scripts/fixtures/with-networks', () => ({
  ALL_POPULAR_NETWORKS: {},
}));
jest.mock('../../../page-objects/flows/onboarding.flow', () => ({
  onboardingMetricsFlow: jest.fn(async () => undefined),
  skipPasskeySetup: jest.fn(async () => undefined),
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
jest.mock('../../../page-objects/pages/home/homepage', () =>
  mockDefaultModule(mockPageObject('HomePage')),
);
jest.mock(
  '../../../page-objects/pages/onboarding/onboarding-complete-page',
  () => mockDefaultModule(mockPageObject('CompletePage')),
);
jest.mock(
  '../../../page-objects/pages/onboarding/onboarding-metrics-page',
  () => mockDefaultModule(mockPageObject('MetricsPage')),
);
jest.mock(
  '../../../page-objects/pages/onboarding/onboarding-password-page',
  () => mockDefaultModule(mockPageObject('PasswordPage')),
);
jest.mock('../../../page-objects/pages/onboarding/onboarding-srp-page', () =>
  mockDefaultModule(mockPageObject('SrpPage')),
);
jest.mock('../../../page-objects/pages/onboarding/setup-passkey-page', () =>
  mockDefaultModule(mockPageObject('SetupPasskeyPage')),
);
jest.mock('../../../page-objects/pages/onboarding/start-onboarding-page', () =>
  mockDefaultModule(mockPageObject('StartPage')),
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
  startInPageStep: jest.fn(async (_driver: unknown, id: string) => {
    mockEvents.push(`probe:${id}`);
    return true;
  }),
  finishInPageStep: jest.fn(async (_driver: unknown, id: string) => {
    mockEvents.push(`read:${id}`);
    return [{ id, value: 1, unit: 'ms' }];
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
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
}));
jest.mock('../../utils/mock-config', () => ({
  getTestSpecificMock: jest.fn(),
  shouldUseMockedRequests: jest.fn(() => true),
}));
jest.mock('../../utils/sidepanel-onboarding', () => ({
  loadHomeAfterSidepanelOnboarding: jest.fn(async () => {
    mockEvents.push('loadHome');
    return process.env.SELENIUM_BROWSER === 'chrome';
  }),
  readCurrentDocumentUiStartup: jest.fn(
    async (_driver: unknown, _endpoints: unknown, id: string) => {
      mockEvents.push(`uiStartup:${id}`);
      return [{ id, value: 1, unit: 'ms' }];
    },
  ),
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
jest.mock('../../../mock-e2e-pass-through', () => ({
  setPassThroughInterceptor: jest.fn(),
}));
jest.mock('../../mocks/performance-mocks', () => ({
  getCommonMocks: jest.fn(() => []),
  benchmarkPassThroughInterceptor: jest.fn(),
  mockBenchmarkEndpoints: jest.fn(async () => []),
  userStorageHostMock: jest.fn(async () => undefined),
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => undefined),
}));

// Imported after the mocks above, which jest hoists over it.
// eslint-disable-next-line import-x/first
import { runOnboardingImportWalletBenchmark } from './onboarding-import-wallet';

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
 * The step timers the run opened, in order.
 *
 * @returns Their ids.
 */
function stepTimers(): string[] {
  return mockEvents
    .filter((event) => event.startsWith('timer:'))
    .map((event) => event.slice('timer:'.length));
}

describe('runOnboardingImportWalletBenchmark', () => {
  const originalBrowser = process.env.SELENIUM_BROWSER;

  beforeEach(() => {
    mockEvents.length = 0;
    mockFixtureOptions.length = 0;
  });
  afterEach(() => {
    if (originalBrowser === undefined) {
      delete process.env.SELENIUM_BROWSER;
    } else {
      process.env.SELENIUM_BROWSER = originalBrowser;
    }
  });

  async function run(
    browser: 'chrome' | 'firefox',
  ): Promise<BenchmarkRunResult> {
    process.env.SELENIUM_BROWSER = browser;
    const result = await runOnboardingImportWalletBenchmark();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  it('names the Chrome password and Done steps for where they end and start', async () => {
    const result = await run('chrome');

    expect(stepTimers()).toStrictEqual([
      'importWalletToSocialScreen',
      'srpButtonToSrpForm',
      'confirmSrpToPwForm',
      'pwFormToPasskeyScreen',
      'metricsToWalletReadyScreen',
      'doneButtonToHomeScreen',
      'openAccountMenuToAccountListLoaded',
    ]);
    const ids = result.timers.map((timer) => timer.id);
    expect(ids).toContain('pwFormToPasskeyScreenLegacy');
    expect(ids).toContain('pwFormToPasskeyScreen');
    expect(ids.filter((id) => id.startsWith('pwFormToMetrics'))).toHaveLength(
      0,
    );
  });

  for (const browser of ['chrome', 'firefox'] as const) {
    it(`reports each series under one name on ${browser}, every step timer as its step id plus Legacy`, async () => {
      const result = await run(browser);

      const ids = result.timers.map((timer) => timer.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toStrictEqual(
        expect.arrayContaining(stepTimers().map((step) => `${step}Legacy`)),
      );
      // Chrome has no in-page timer for Done, so its step id is not reported
      // at all there.
      expect(ids.includes('doneButtonToHomeScreen')).toBe(
        browser === 'firefox',
      );
    });
  }

  it('keeps the Firefox names of the steps it does not rename', async () => {
    await run('firefox');

    expect(stepTimers()).toStrictEqual([
      'importWalletToSocialScreen',
      'srpButtonToSrpForm',
      'confirmSrpToPwForm',
      'metricsToWalletReadyScreen',
      'doneButtonToHomeScreen',
      'openAccountMenuToAccountListLoaded',
    ]);
  });

  it('waits for page idle before each of the first two probes, outside the previous step', async () => {
    await run('chrome');

    expect(mockEvents.filter((event) => event === 'pageIdle')).toHaveLength(2);
    const first = mockEvents.indexOf('pageIdle');
    const second = mockEvents.indexOf('pageIdle', first + 1);
    expect(at('StartPage.checkLoginPageIsLoaded')).toBeLessThan(first);
    expect(first).toBeLessThan(at('probe:importWalletToSocialScreen'));
    expect(at('read:importWalletToSocialScreen')).toBeLessThan(second);
    expect(second).toBeLessThan(at('probe:srpButtonToSrpForm'));
  });

  it('waits for account syncing after the Done step and before the account-list probe', async () => {
    await run('chrome');

    expect(
      mockEvents.filter((event) => event === 'accountSyncIdle'),
    ).toHaveLength(1);
    expect(at('timerEnd:doneButtonToHomeScreen')).toBeLessThan(
      at('accountSyncIdle'),
    );
    expect(at('accountSyncIdle')).toBeLessThan(
      at('probe:openAccountMenuToAccountListLoaded'),
    );
  });

  it('reads UI Startup on Chrome after the last timer, under a name for the harness navigation', async () => {
    const result = await run('chrome');

    expect(at('timerEnd:openAccountMenuToAccountListLoaded')).toBeLessThan(
      at('uiStartup:harnessHomeNavigationToUiStartup'),
    );
    expect(result.timers.map((timer) => timer.id)).toContain(
      'harnessHomeNavigationToUiStartup',
    );
  });

  it('reads no UI Startup on Firefox, where the harness loads no home page', async () => {
    await run('firefox');

    expect(mockEvents.some((event) => event.startsWith('uiStartup:'))).toBe(
      false,
    );
  });
});
