import type { Driver } from '../../webdriver/driver';
import { calculateTimerStatistics } from './statistics';
import {
  collectGarbageBetweenIterations,
  convertTimerStatisticsToBenchmarkResults,
} from './runner';

function createMockDriver(
  overrides: {
    executeScript?: jest.Mock;
    innerSendDevToolsCommand?: jest.Mock | null;
  } = {},
): Driver {
  const innerDriver: Record<string, unknown> = {};

  if (overrides.innerSendDevToolsCommand !== null) {
    innerDriver.sendDevToolsCommand =
      overrides.innerSendDevToolsCommand ??
      jest.fn().mockResolvedValue(undefined);
  }

  return {
    executeScript: overrides.executeScript ?? jest.fn().mockResolvedValue(true),
    driver:
      overrides.innerSendDevToolsCommand === null ? undefined : innerDriver,
  } as unknown as Driver;
}

describe('collectGarbageBetweenIterations', () => {
  it('uses window.gc when exposed on the page', async () => {
    const executeScript = jest.fn().mockResolvedValue(true);
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendDevToolsCommand).not.toHaveBeenCalled();
  });

  it('falls back to HeapProfiler.collectGarbage when window.gc is unavailable', async () => {
    const executeScript = jest.fn().mockResolvedValue(false);
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(sendDevToolsCommand).toHaveBeenCalledTimes(1);
    expect(sendDevToolsCommand).toHaveBeenCalledWith(
      'HeapProfiler.collectGarbage',
    );
  });

  it('falls back to CDP when window.gc execution throws', async () => {
    const executeScript = jest
      .fn()
      .mockRejectedValue(new Error('script failed'));
    const sendDevToolsCommand = jest.fn().mockResolvedValue(undefined);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: sendDevToolsCommand,
    });

    await collectGarbageBetweenIterations(driver);

    expect(sendDevToolsCommand).toHaveBeenCalledWith(
      'HeapProfiler.collectGarbage',
    );
  });

  it('does nothing when neither window.gc nor CDP are available', async () => {
    const executeScript = jest.fn().mockResolvedValue(false);
    const driver = createMockDriver({
      executeScript,
      innerSendDevToolsCommand: null,
    });

    await expect(
      collectGarbageBetweenIterations(driver),
    ).resolves.toBeUndefined();
  });
});

describe('convertTimerStatisticsToBenchmarkResults — per-iteration projection', () => {
  // This is the JOINT between the producer and the artifact. `calculateTimerStatistics`
  // retaining `runs` is covered in statistics.test.ts, and the projection below is what
  // actually puts those values in the CI JSON that stage 3 reads. A component test on
  // either side passes while the join is broken, so it is tested through the real
  // producer rather than a hand-built TimerStatistics.
  it('carries per-iteration values into timerRuns, with iterations and exclusions intact', () => {
    // 426 and 1000 are dropped by the IQR fences, then 264 by z-score on what survives.
    const durations = [
      98, 99, 98, 99, 99, 102, 101, 100, 101, 99, 426, 264, 165, 1000,
    ];
    const stats = calculateTimerStatistics('uiStartup', durations, {
      iterations: durations.map((_, i) => i),
    });

    const results = convertTimerStatisticsToBenchmarkResults(
      [stats],
      'benchmark-startup',
    );

    expect(results.timerRuns).toBeDefined();
    const runs = results.timerRuns?.uiStartup;
    expect(runs).toHaveLength(durations.length);

    // Every input value survives into the artifact, excluded ones included.
    expect(runs?.map((r) => r.value)).toStrictEqual(durations);
    // Iteration indices are explicit, not array positions.
    expect(runs?.map((r) => r.iteration)).toStrictEqual(
      durations.map((_, i) => i),
    );
    // The values the summary was computed from are the ones left unexcluded.
    const kept = runs?.filter((r) => r.excludedBy === undefined) ?? [];
    expect(kept.length).toBeLessThan(durations.length);
    expect(results.mean.uiStartup).toBeCloseTo(
      kept.reduce((a, r) => a + r.value, 0) / kept.length,
      10,
    );
    // At least one exclusion is attributed, and only to a known filter.
    const reasons = new Set(
      runs?.flatMap((r) => (r.excludedBy ? [r.excludedBy] : [])),
    );
    expect(reasons.size).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(['sanity', 'iqr', 'zScore']).toContain(reason);
    }
  });

  it('omits timerRuns entirely when no timer carries samples', () => {
    const stats = calculateTimerStatistics('uiStartup', [100, 101, 102]);
    const withoutRuns = { ...stats };
    delete (withoutRuns as { runs?: unknown }).runs;

    const results = convertTimerStatisticsToBenchmarkResults(
      [withoutRuns],
      'benchmark-startup',
    );

    expect(results).not.toHaveProperty('timerRuns');
    expect(results.mean.uiStartup).toBeCloseTo(101, 10);
  });

  it('projects only the timers that carry samples', () => {
    const withSamples = calculateTimerStatistics('withSamples', [10, 11, 12], {
      iterations: [0, 1, 2],
    });
    const bare = { ...calculateTimerStatistics('bare', [20, 21, 22]) };
    delete (bare as { runs?: unknown }).runs;

    const results = convertTimerStatisticsToBenchmarkResults(
      [withSamples, bare],
      'benchmark-mixed',
    );

    expect(Object.keys(results.timerRuns ?? {})).toStrictEqual(['withSamples']);
    expect(results.mean).toHaveProperty('bare');
  });
});
