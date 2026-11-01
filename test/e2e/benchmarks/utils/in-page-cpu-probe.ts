import FixtureBuilderV2 from '../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../helpers';
import LoginPage from '../../page-objects/pages/onboarding/login-page';
import type { Driver } from '../../webdriver/driver';
import { resolveAfterTwoIdlePeriods } from './sidepanel-onboarding';
import type { InPageCpuProbeReading } from './types';

/**
 * The in-page CPU probe: a fixed amount of work, timed with the page's own
 * `performance.now()` in an extension page, read before a flow's first
 * iteration and after each one (`runBenchmarkWithIterations`). Its readings
 * go into the flow's result beside the `host` fields.
 *
 * It is the counterpart `host-provenance.ts` names as not implemented: that
 * probe times the test process, which says nothing about the CPU the browser
 * received. Each iteration runs in a browser session of its own, so each
 * reading runs in one too, between the iterations' sessions: the same
 * fixture, the same page and the same work every time.
 *
 * A run with the switch set therefore starts one more browser session per
 * iteration, plus one. Unset, nothing here runs.
 */
export const IN_PAGE_CPU_PROBE = 'BENCHMARK_IN_PAGE_CPU_PROBE';

/**
 * Rounds of the probe's loop. Set from the loop's repeatability in fresh Node
 * processes on a 4-core Linux VM, which run the same engine cold, as each
 * probe session does; 20 processes per setting:
 *
 *        rounds     mean      CV
 *    10,000,000    20.7 ms   2.0%
 *    30,000,000    59.5 ms   0.4%
 *   100,000,000   195.8 ms   0.7%
 *
 * Not measured in the page: the browser's engine version and its tiering
 * may differ.
 */
export const IN_PAGE_CPU_PROBE_ROUNDS = 30_000_000;

/**
 * Time the fixed work on the page's main thread. Runs in the page, through
 * `executeScript`, so it may use nothing from outside its own body but
 * `performance`, which is on every build's LavaMoat scuttling exception list.
 *
 * The work is a chained xorshift, so each round depends on the one before,
 * and the result is returned, so the loop cannot be dropped as dead.
 *
 * @param args - One-element tuple holding the number of rounds.
 * @param args."0" - The number of rounds.
 * @returns The elapsed ms, and the loop's result.
 */
export function timeFixedWorkInPage([rounds]: [number]): [number, number] {
  const start = performance.now();
  let x = 2463534242;
  /* eslint-disable no-bitwise */
  for (let i = 0; i < rounds; i += 1) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  /* eslint-enable no-bitwise */
  return [performance.now() - start, x];
}

/**
 * Take one reading in a browser session of its own: load the extension's
 * home page on a default fixture, wait for the unlock screen and two idle
 * periods of the page, then time the fixed work.
 *
 * Never throws. A session that fails before the work ran gives a reading with
 * an `error`; one that fails after it, as `withFixtures` does when the page
 * logged an error, keeps the time.
 *
 * @returns The reading.
 */
export async function readInPageCpuProbe(): Promise<InPageCpuProbeReading> {
  let reading: InPageCpuProbeReading | undefined;
  try {
    await withFixtures(
      {
        title: 'benchmark-in-page-cpu-probe',
        fixtures: new FixtureBuilderV2().build(),
        disableServerMochaToBackground: true,
      },
      async ({ driver }: { driver: Driver }) => {
        await driver.navigate();
        await new LoginPage(driver).checkPageIsLoaded();
        await driver.executeAsyncScript(resolveAfterTwoIdlePeriods);
        const result = (await driver.executeScript(
          timeFixedWorkInPage,
          IN_PAGE_CPU_PROBE_ROUNDS,
        )) as unknown;
        reading =
          Array.isArray(result) && typeof result[0] === 'number'
            ? { ms: result[0] }
            : { error: `the page returned ${JSON.stringify(result)}` };
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (reading === undefined) {
      reading = { error: message };
    } else {
      console.log(
        `[benchmark] in-page CPU probe: kept the reading; the session then failed: ${message}`,
      );
    }
  }
  return reading ?? { error: 'the probe session ended without a reading' };
}

/**
 * The reader `runBenchmarkWithIterations` takes, when
 * `BENCHMARK_IN_PAGE_CPU_PROBE=1`.
 *
 * @returns The reader, {@link readInPageCpuProbe}, or nothing when the switch
 * is unset.
 */
export function inPageCpuProbeReader():
  | (() => Promise<InPageCpuProbeReading>)
  | undefined {
  return process.env[IN_PAGE_CPU_PROBE] === '1'
    ? readInPageCpuProbe
    : undefined;
}
