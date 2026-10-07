import { captureRunProvenance } from './run-provenance';

describe('captureRunProvenance', () => {
  const KEYS = [
    'GITHUB_SHA',
    'BENCHMARK_ITERATIONS',
    'BENCHMARK_PERSONA',
    'BENCHMARK_POLL_TIMEOUT_MS',
    'BENCHMARK_ZERO_MOCK_DELAYS',
    'BENCHMARK_V14_INJECT',
    'BENCHMARK_APP_SPAN_DELAY_MS',
  ];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
  });

  afterEach(() => {
    KEYS.forEach((k) => {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    });
  });

  it('reads every field from the environment', () => {
    process.env.GITHUB_SHA = 'abc123';
    process.env.BENCHMARK_ITERATIONS = '5';
    process.env.BENCHMARK_PERSONA = 'powerUser';
    process.env.BENCHMARK_POLL_TIMEOUT_MS = '500';

    expect(captureRunProvenance()).toStrictEqual({
      commit: 'abc123',
      iterations: 5,
      persona: 'powerUser',
      pollTimeoutMs: 500,
      mockRegime: 'prod',
      arm: '',
    });
  });

  it('reports an unset poll timeout as null rather than omitting it', () => {
    // The distinction the field exists for: `null` is "measured at selenium's
    // default", an absent key is "measured before this field existed". An I1 sweep
    // whose arms differ only by this value cannot be audited if they collapse.
    const p = captureRunProvenance();
    expect(p.pollTimeoutMs).toBeNull();
    expect('pollTimeoutMs' in p).toBe(true);
  });

  it('names the mock regime from the zeroing flag', () => {
    expect(captureRunProvenance().mockRegime).toBe('prod');
    process.env.BENCHMARK_ZERO_MOCK_DELAYS = '1';
    expect(captureRunProvenance().mockRegime).toBe('zero-delay');
  });

  it('records a control arm as empty and a composite arm as both parts', () => {
    expect(captureRunProvenance().arm).toBe('');
    process.env.BENCHMARK_V14_INJECT = 'swap-quote';
    process.env.BENCHMARK_APP_SPAN_DELAY_MS = '98';
    expect(captureRunProvenance().arm).toBe('v14:swap-quote,appSpanDelay:98');
  });

  it('drops a non-numeric iteration count instead of emitting NaN', () => {
    process.env.BENCHMARK_ITERATIONS = 'five';
    expect(captureRunProvenance().iterations).toBeUndefined();
  });
});
