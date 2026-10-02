import { QUOTE_DELAY_ENV_VAR } from './swap-mocks';

/**
 * The quote delay has to take effect on the mocks that actually serve the
 * benchmark. An earlier version wired it into `registerSwapInterceptor`, whose
 * caller is guarded by a predicate that is always false, so the knob existed,
 * was tested, and moved nothing. These assert the LIVE constant.
 */
describe('performance-mocks quote delay', () => {
  const original = process.env[QUOTE_DELAY_ENV_VAR];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[QUOTE_DELAY_ENV_VAR];
    } else {
      process.env[QUOTE_DELAY_ENV_VAR] = original;
    }
    jest.resetModules();
  });

  async function loadDelay(): Promise<number> {
    jest.resetModules();
    const mod = await import('./performance-mocks');
    return mod.QUOTE_MOCK_DELAY_MS;
  }

  it('is the 2000 ms baseline when nothing is injected', async () => {
    delete process.env[QUOTE_DELAY_ENV_VAR];
    expect(await loadDelay()).toBe(2000);
  });

  it('adds the injected delay on top of the baseline', async () => {
    process.env[QUOTE_DELAY_ENV_VAR] = '538';
    expect(await loadDelay()).toBe(2538);
  });

  it('ignores a malformed value rather than shifting the baseline', async () => {
    process.env[QUOTE_DELAY_ENV_VAR] = 'not-a-number';
    expect(await loadDelay()).toBe(2000);
  });

  it('ignores a non-positive value', async () => {
    process.env[QUOTE_DELAY_ENV_VAR] = '-100';
    expect(await loadDelay()).toBe(2000);
  });
});
