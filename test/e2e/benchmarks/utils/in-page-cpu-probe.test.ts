import type { Driver } from '../../webdriver/driver';
import {
  IN_PAGE_CPU_PROBE,
  IN_PAGE_CPU_PROBE_ROUNDS,
  inPageCpuProbeReader,
  readInPageCpuProbe,
  timeFixedWorkInPage,
} from './in-page-cpu-probe';
import { resolveAfterTwoIdlePeriods } from './sidepanel-onboarding';

const mockEvents: string[] = [];
const mockFixtureOptions: Record<string, unknown>[] = [];
const mockSession: {
  executeScript: (script: unknown, ...args: unknown[]) => Promise<unknown>;
  failAfterTest: Error | null;
} = {
  executeScript: async () => [59.5, 123],
  failAfterTest: null,
};

jest.mock('../../helpers', () => ({
  withFixtures: jest.fn(
    async (
      options: Record<string, unknown>,
      callback: (args: { driver: unknown }) => Promise<void>,
    ): Promise<void> => {
      mockFixtureOptions.push(options);
      await callback({
        driver: {
          navigate: async () => {
            mockEvents.push('navigate');
          },
          executeAsyncScript: async (script: { name: string }) => {
            mockEvents.push(`executeAsyncScript:${script.name}`);
          },
          executeScript: async (
            script: { name: string },
            ...args: unknown[]
          ) => {
            mockEvents.push(`executeScript:${script.name}:${args.join(',')}`);
            return await mockSession.executeScript(script, ...args);
          },
        },
      });
      if (mockSession.failAfterTest) {
        throw mockSession.failAfterTest;
      }
    },
  ),
}));
jest.mock('../../fixtures/fixture-builder-v2', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    build: () => ({ fixture: 'default' }),
  })),
}));
jest.mock('../../page-objects/pages/onboarding/login-page', () => ({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __esModule: true,
  default: jest.fn().mockImplementation((driver: Driver) => ({
    checkPageIsLoaded: async () => {
      mockEvents.push(`LoginPage.checkPageIsLoaded:${driver ? 'driver' : ''}`);
    },
  })),
}));
jest.mock('./sidepanel-onboarding', () => ({
  resolveAfterTwoIdlePeriods() {
    return undefined;
  },
}));

describe('timeFixedWorkInPage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('times the loop with the page clock, from before its first round to after its last', () => {
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(160.5);

    const [ms] = timeFixedWorkInPage([1000]);

    expect(ms).toBe(60.5);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("runs exactly the rounds it is given of xorshift32's (13, 17, 5) step", () => {
    // The sequence from 2463534242. The second term, -1797600390, is
    // 2497366906 as an unsigned 32-bit value.
    expect(timeFixedWorkInPage([0])[1]).toBe(2463534242);
    expect(timeFixedWorkInPage([1])[1]).toBe(723471715);
    expect(timeFixedWorkInPage([2])[1]).toBe(-1797600390);
    expect(timeFixedWorkInPage([3])[1]).toBe(2064144800);
  });
});

describe('readInPageCpuProbe', () => {
  beforeEach(() => {
    mockEvents.length = 0;
    mockFixtureOptions.length = 0;
    mockSession.executeScript = async () => [59.5, 123];
    mockSession.failAfterTest = null;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the unlock page in a session of its own, waits for two idle periods, then times the fixed work', async () => {
    expect(await readInPageCpuProbe()).toStrictEqual({ ms: 59.5 });

    expect(mockFixtureOptions).toHaveLength(1);
    expect(mockFixtureOptions[0]).toMatchObject({
      title: 'benchmark-in-page-cpu-probe',
      fixtures: { fixture: 'default' },
    });
    expect(mockEvents).toStrictEqual([
      'navigate',
      'LoginPage.checkPageIsLoaded:driver',
      `executeAsyncScript:${resolveAfterTwoIdlePeriods.name}`,
      `executeScript:timeFixedWorkInPage:${IN_PAGE_CPU_PROBE_ROUNDS}`,
    ]);
  });

  it('keeps the time when the session fails after the work, as withFixtures does on a page error', async () => {
    mockSession.failAfterTest = new Error(
      'SyntaxError: Unexpected end of JSON input',
    );

    expect(await readInPageCpuProbe()).toStrictEqual({ ms: 59.5 });
  });

  it('gives an error, without throwing, when the session fails before the work', async () => {
    mockSession.executeScript = async () => {
      throw new Error('javascript error: performance is not defined');
    };

    expect(await readInPageCpuProbe()).toStrictEqual({
      error: 'javascript error: performance is not defined',
    });
  });

  it('gives an error when the page returns something other than a time', async () => {
    mockSession.executeScript = async () => null;

    expect(await readInPageCpuProbe()).toStrictEqual({
      error: 'the page returned null',
    });
  });
});

describe('inPageCpuProbeReader', () => {
  const original = process.env[IN_PAGE_CPU_PROBE];
  afterEach(() => {
    if (original === undefined) {
      delete process.env[IN_PAGE_CPU_PROBE];
    } else {
      process.env[IN_PAGE_CPU_PROBE] = original;
    }
  });

  it('gives no reader unless the switch is 1', () => {
    delete process.env[IN_PAGE_CPU_PROBE];
    expect(inPageCpuProbeReader()).toBeUndefined();
    process.env[IN_PAGE_CPU_PROBE] = '0';
    expect(inPageCpuProbeReader()).toBeUndefined();
    process.env[IN_PAGE_CPU_PROBE] = '1';
    expect(inPageCpuProbeReader()).toBe(readInPageCpuProbe);
  });
});
