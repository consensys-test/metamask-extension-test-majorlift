/**
 * Naming and order checks for the new-wallet onboarding flow, with the
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
jest.mock('../../../constants', () => ({ WALLET_PASSWORD: 'password' }));
jest.mock('../../../../../app/scripts/fixtures/with-networks', () => ({
  ALL_POPULAR_NETWORKS: {},
}));
jest.mock('../../../page-objects/flows/onboarding.flow', () => ({
  onboardingMetricsFlow: jest.fn(async () => undefined),
  skipPasskeySetup: jest.fn(async () => undefined),
}));
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
jest.mock('../../../page-objects/pages/onboarding/secure-wallet-page', () =>
  mockDefaultModule(mockPageObject('SecureWalletPage')),
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
  NEW_WALLET_TRACES: 'BENCHMARK_NEW_WALLET_TRACES',
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
}));
jest.mock('../../utils', () => ({
  collectWebVitals: jest.fn(async () => undefined),
}));

// Imported after the mocks above, which jest hoists over it.
// eslint-disable-next-line import-x/first
import { runOnboardingNewWalletBenchmark } from './onboarding-new-wallet';

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

describe('runOnboardingNewWalletBenchmark', () => {
  const original = {
    browser: process.env.SELENIUM_BROWSER,
    traces: process.env.BENCHMARK_NEW_WALLET_TRACES,
  };

  beforeEach(() => {
    mockEvents.length = 0;
    mockFixtureOptions.length = 0;
  });
  afterEach(() => {
    for (const [name, value] of [
      ['SELENIUM_BROWSER', original.browser],
      ['BENCHMARK_NEW_WALLET_TRACES', original.traces],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  async function run(
    browser: 'chrome' | 'firefox',
    traces?: string,
  ): Promise<BenchmarkRunResult> {
    process.env.SELENIUM_BROWSER = browser;
    if (traces === undefined) {
      delete process.env.BENCHMARK_NEW_WALLET_TRACES;
    } else {
      process.env.BENCHMARK_NEW_WALLET_TRACES = traces;
    }
    const result = await runOnboardingNewWalletBenchmark();
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    return result;
  }

  function manifestFlags(): Record<string, unknown> {
    return mockFixtureOptions[0].manifestFlags as Record<string, unknown>;
  }

  it('names the Chrome password and Done steps for where they end and start', async () => {
    const result = await run('chrome');

    expect(stepTimers()).toStrictEqual([
      'createWalletToSocialScreen',
      'srpButtonToPwForm',
      'createPwToPasskeyScreen',
      'skipBackupToMetricsScreen',
      'agreeButtonToOnboardingSuccess',
      'doneButtonToAssetList',
    ]);
    const ids = result.timers.map((timer) => timer.id);
    expect(ids).toContain('createPwToPasskeyScreenLegacy');
    expect(ids).toContain('createPwToPasskeyScreen');
    expect(
      ids.filter((id) => id.startsWith('createPwToRecovery')),
    ).toHaveLength(0);
  });

  it('keeps the Firefox names, whose steps match them', async () => {
    const result = await run('firefox');

    expect(stepTimers()).toStrictEqual([
      'createWalletToSocialScreen',
      'srpButtonToPwForm',
      'createPwToRecoveryScreen',
      'agreeButtonToOnboardingSuccess',
      'doneButtonToAssetList',
    ]);
    expect(result.timers.map((timer) => timer.id)).toStrictEqual(
      expect.arrayContaining([
        'createPwToRecoveryScreenLegacy',
        'createPwToRecoveryScreen',
      ]),
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
      expect(ids.includes('doneButtonToAssetList')).toBe(browser === 'firefox');
    });
  }

  it('waits for page idle before each of the first two probes, outside the previous step', async () => {
    await run('chrome');

    expect(mockEvents.filter((event) => event === 'pageIdle')).toHaveLength(2);
    const first = mockEvents.indexOf('pageIdle');
    const second = mockEvents.indexOf('pageIdle', first + 1);
    expect(at('StartPage.checkLoginPageIsLoaded')).toBeLessThan(first);
    expect(first).toBeLessThan(at('probe:createWalletToSocialScreen'));
    expect(at('read:createWalletToSocialScreen')).toBeLessThan(second);
    expect(second).toBeLessThan(at('probe:srpButtonToPwForm'));
  });

  it('neither samples every trace nor reads UI Startup when the switch is unset', async () => {
    const result = await run('chrome');

    expect(manifestFlags()).not.toHaveProperty('sentry');
    expect(mockEvents.some((event) => event.startsWith('uiStartup:'))).toBe(
      false,
    );
    expect(result.timers.map((timer) => timer.id)).not.toContain(
      'harnessHomeNavigationToUiStartup',
    );
  });

  it('neither samples every trace nor reads UI Startup when the switch is 0', async () => {
    await run('chrome', '0');

    expect(manifestFlags()).not.toHaveProperty('sentry');
    expect(mockEvents.some((event) => event.startsWith('uiStartup:'))).toBe(
      false,
    );
  });

  it('samples every trace and reads UI Startup after the last timer on Chrome when the switch is 1', async () => {
    const result = await run('chrome', '1');

    expect(manifestFlags().sentry).toStrictEqual({ tracesSampleRate: 1 });
    expect(at('timerEnd:doneButtonToAssetList')).toBeLessThan(
      at('uiStartup:harnessHomeNavigationToUiStartup'),
    );
    expect(result.timers.map((timer) => timer.id)).toContain(
      'harnessHomeNavigationToUiStartup',
    );
  });

  it('reads no UI Startup on Firefox, where the harness loads no home page', async () => {
    await run('firefox', '1');

    expect(manifestFlags().sentry).toStrictEqual({ tracesSampleRate: 1 });
    expect(mockEvents.some((event) => event.startsWith('uiStartup:'))).toBe(
      false,
    );
  });
});
