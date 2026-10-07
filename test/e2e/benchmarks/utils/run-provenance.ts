import type { RunProvenance } from '../../../../shared/constants/benchmarks';

/**
 * Read the harness configuration a run was measured under.
 *
 * Every field is read from the environment at result-assembly time rather than
 * threaded through the call stack, for the same reason `host-provenance.ts` is: the
 * values are constant for the process and a parameter would have to be passed through
 * every flow to reach the one place that serialises them.
 *
 * Absent variables stay `undefined` and are dropped by `JSON.stringify`, EXCEPT
 * `pollTimeoutMs`, which reports `null` when unset. A reader has to be able to tell
 * "measured at selenium's default" from "measured before this field existed", and an
 * omitted key cannot carry that difference.
 */
export function captureRunProvenance(): RunProvenance {
  const num = (v: string | undefined): number | undefined => {
    if (v === undefined || v === '') {
      return undefined;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const zeroed = process.env.BENCHMARK_ZERO_MOCK_DELAYS === '1';
  const arm = [
    process.env.BENCHMARK_V14_INJECT
      ? `v14:${process.env.BENCHMARK_V14_INJECT}`
      : '',
    num(process.env.BENCHMARK_APP_SPAN_DELAY_MS)
      ? `appSpanDelay:${process.env.BENCHMARK_APP_SPAN_DELAY_MS}`
      : '',
  ]
    .filter(Boolean)
    .join(',');

  return {
    commit: process.env.GITHUB_SHA || undefined,
    jobName: process.env.GITHUB_JOB || undefined,
    iterations: num(process.env.BENCHMARK_ITERATIONS),
    persona: process.env.BENCHMARK_PERSONA || undefined,
    pollTimeoutMs: num(process.env.BENCHMARK_POLL_TIMEOUT_MS) ?? null,
    mockRegime: zeroed ? 'zero-delay' : 'prod',
    arm,
  };
}
