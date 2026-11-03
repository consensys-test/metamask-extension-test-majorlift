/**
 * The startup flows' post-hero long-task record, with the browser, the page
 * objects and the web-vitals collector replaced. The fake driver runs the
 * in-page functions `readStartupPageSignals` sends it against a stubbed
 * `performance` and `stateHooks`, so the flows read the page as they do on a
 * run, and each test can compare what a flow read from the page with the
 * switch unset, `0` and `1`.
 */

import type { PageLoadBenchmarkResults } from '../../utils/runner';
import { run as runPowerUser } from './power-user-home';
import { run as runStandard } from './standard-home';

const SWITCH = 'BENCHMARK_STARTUP_POST_HERO_LONG_TASKS';
const LEVER_SWITCHES = [
  'BENCHMARK_KNOWN_ANSWER_STARTUP_DELAY_MS',
  'BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS',
  'BENCHMARK_STARTUP_SETTLE_QUIET_MS',
];

/** The hero mark's `startTime` on the fake page. */
const HERO = 850;
/** `uiStartup` on the fake page, in the page's `performance.now()` frame. */
const UI_STARTUP = 1000;

/**
 * The long tasks the fake page's app stored, in the order it stored them: two
 * before the hero mark, one at it, one in `uiStartup` after it and one after
 * `uiStartup`.
 */
const STORED_TASKS = [
  { startTime: 120, duration: 300 },
  { startTime: HERO - 1, duration: 55 },
  { startTime: HERO, duration: 51 },
  { startTime: HERO + 12, duration: 62 },
  { startTime: UI_STARTUP + 400, duration: 88 },
];

/** What the flows record for {@link STORED_TASKS} on each measured page load. */
const EXPECTED_ROW = {
  tasks: [
    { start: 0, duration: 51, beforeUiStartupEnd: true },
    { start: 12, duration: 62, beforeUiStartupEnd: true },
    { start: 550, duration: 88, beforeUiStartupEnd: false },
  ],
  notStored: 0,
};

/** Every call the flows made on the fake driver and the page. */
const mockCalls: string[] = [];

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

jest.mock('../../utils/host-provenance', () => ({
  captureHostProvenance: () => ({ label: 'test' }),
}));
jest.mock('../../utils/web-vitals-collector', () => ({
  collectWebVitals: jest.fn(async () => {
    mockCalls.push('collectWebVitals');
    return {};
  }),
}));
jest.mock('../../../webdriver/driver', () => ({}));
jest.mock('../../../page-objects/flows/login.flow', () => ({
  login: jest.fn(async () => undefined),
}));
jest.mock('../../../fixtures/fixture-builder-v2', () =>
  mockDefaultModule(
    jest.fn().mockImplementation(() => ({ build: () => ({}) })),
  ),
);
jest.mock('../../../../../app/scripts/fixtures/generate-wallet-state', () => ({
  generateWalletState: jest.fn(async () => ({ build: () => ({}) })),
}));
jest.mock('../../../tests/notifications/mocks', () => ({
  mockNotificationServices: jest.fn(),
}));
jest.mock('../../mocks/performance-mocks', () => ({
  userStorageHostMock: jest.fn(),
}));
jest.mock('../../../page-objects/pages/home/header-navbar', () =>
  mockDefaultModule(
    jest.fn().mockImplementation(() => ({
      openAccountMenu: async () => undefined,
    })),
  ),
);
jest.mock('../../../page-objects/pages/accounts/list-page', () =>
  mockDefaultModule(
    jest.fn().mockImplementation(() => ({
      waitUntilSyncingIsCompleted: async () => undefined,
      checkNumberOfAvailableAccounts: async () => undefined,
      checkAccountDisplayedInAccountList: async () => undefined,
    })),
  ),
);
jest.mock('../../../helpers', () => ({
  withFixtures: jest.fn(
    async (
      _options: unknown,
      callback: (args: unknown) => Promise<void>,
    ): Promise<void> => {
      const driver = {
        // A CDP session, so a startup lever can register its script.
        driver: { sendDevToolsCommand: jest.fn(async () => undefined) },
        navigate: jest.fn(async () => {
          mockCalls.push('navigate');
        }),
        delay: jest.fn(async () => undefined),
        collectMetrics: jest.fn(async () => {
          mockCalls.push('collectMetrics');
          return {
            navigation: [
              {
                load: 1100,
                domContentLoaded: 900,
                domInteractive: 20,
                type: 'navigate',
              },
            ],
            paint: {},
            'UI Startup': 1000,
            'Background Connect': 30,
            'First Render': 2,
            'Initial Actions': 2,
            'Load Scripts': 400,
            'Setup Store': 18,
            // As `collectMetrics` returns them: up to collection.
            longTaskCount: 9,
            longTaskTotalDuration: 900,
            longTaskMaxDuration: 300,
            tbt: 450,
          };
        }),
        executeScript: jest.fn(async (script: () => unknown) => {
          mockCalls.push('executeScript');
          return script();
        }),
      };
      await callback({
        driver,
        getNetworkReport: () => ({ numNetworkReqs: 40 }),
        clearNetworkReport: () => undefined,
        getBrowserErrors: () => undefined,
      });
    },
  ),
}));

const pageWindow = window as unknown as { stateHooks?: unknown };
const originalGetEntriesByName = performance.getEntriesByName;
const saved: Record<string, string | undefined> = {};

describe('startup flows: post-hero long tasks', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    for (const name of [SWITCH, ...LEVER_SWITCHES]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    performance.getEntriesByName = jest.fn((name: string) =>
      name === 'mm-hero-painted' ? [{ startTime: HERO }] : [],
    ) as unknown as typeof performance.getEntriesByName;
    pageWindow.stateHooks = {
      getLongTaskMetrics: () => ({
        observed: true,
        count: STORED_TASKS.length,
        tasks: STORED_TASKS.map((task) => ({ name: 'self', ...task })),
      }),
    };
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    delete pageWindow.stateHooks;
    performance.getEntriesByName = originalGetEntriesByName;
  });

  type FlowRun = (options: {
    browserLoads: number;
    pageLoads: number;
  }) => Promise<PageLoadBenchmarkResults>;
  const flows: [string, FlowRun][] = [
    ['standard-home', runStandard],
    ['power-user-home', runPowerUser],
  ];

  for (const [flowName, run] of flows) {
    describe(flowName, () => {
      // Two browser loads of two page loads: the first browser load is the
      // discarded warm-up, and the first page load of the other is flagged.
      const options = { browserLoads: 2, pageLoads: 2 };

      const offValues: [string, string | undefined][] = [
        ['unset', undefined],
        ['empty', ''],
        ['0', '0'],
      ];
      for (const [label, value] of offValues) {
        it(`records nothing when the switch is ${label}`, async () => {
          if (value !== undefined) {
            process.env[SWITCH] = value;
          }

          const results: PageLoadBenchmarkResults = await run(options);

          expect(results).not.toHaveProperty('postHeroLongTasks');
        });
      }

      it('records the tasks at or after the hero mark for each measured page load when the switch is 1', async () => {
        process.env[SWITCH] = '1';

        const results = await run(options);

        expect(results.postHeroLongTasks).toStrictEqual([
          { iteration: 2, ...EXPECTED_ROW, excluded: 'first-page-load' },
          { iteration: 3, ...EXPECTED_ROW },
        ]);
      });

      it('changes no series, and reads the page no more often than with the switch unset', async () => {
        const unset = await run(options);
        const unsetCalls = [...mockCalls];
        mockCalls.length = 0;
        process.env[SWITCH] = '1';

        const on = await run(options);

        const { postHeroLongTasks, ...rest } = on;
        expect(postHeroLongTasks).toHaveLength(2);
        expect(rest).toStrictEqual(unset);
        expect(mockCalls).toStrictEqual(unsetCalls);
      });

      it('records the tasks after the lever marks when a startup lever is set too', async () => {
        process.env[SWITCH] = '1';
        process.env.BENCHMARK_KNOWN_ANSWER_STARTUP_SYNC_BLOCK_MS = '300';

        const results = await run(options);

        // The fake page has no lever marks, so each load's marks read null.
        expect(results.leverMarks).toStrictEqual([
          {
            iteration: 2,
            start: null,
            end: null,
            excluded: 'first-page-load',
          },
          { iteration: 3, start: null, end: null },
        ]);
        expect(results.postHeroLongTasks).toHaveLength(2);
        const keys = Object.keys(results);
        expect(keys.indexOf('leverMarks')).toBe(keys.indexOf('values') + 1);
        expect(keys.indexOf('postHeroLongTasks')).toBe(
          keys.indexOf('leverMarks') + 1,
        );
      });
    });
  }
});
