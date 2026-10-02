import type { Mockttp } from 'mockttp';
import type {
  PassThroughInterceptor,
  PassThroughInterceptorResult,
} from '../../mock-e2e-pass-through';
import {
  QUOTE_DELAY_ENV_VAR,
  readQuoteDelayMs,
  registerSwapInterceptor,
} from './swap-mocks';

const SSE_URL =
  'https://bridge.api.cx.metamask.io/getQuoteStream?walletAddress=0x1';
const REST_URL = 'https://bridge.api.cx.metamask.io/getQuote?walletAddress=0x1';
const FEATURE_FLAGS_URL = 'https://bridge.api.cx.metamask.io/featureFlags';
const CLIENT_CONFIG_URL =
  'https://client-config.api.cx.metamask.io/v1/flags?client=extension';
const SOLANA_URL = 'https://solana-mainnet.infura.io/v3/project-id';
const UNMATCHED_URL = 'https://example.com/not-mocked';

const DELAY_MS = 538;

/**
 * Values that are set but cannot be used as a delay. Each must leave
 * the default, undelayed path in place.
 */
const UNUSABLE_DELAY_VALUES: [value: string, description: string][] = [
  ['', 'empty'],
  ['abc', 'non-numeric'],
  ['538ms', 'trailing garbage'],
  ['NaN', 'NaN'],
  ['Infinity', 'infinite'],
  ['0', 'zero'],
  ['-100', 'negative'],
];

/**
 * Register the swap interceptor against a stub server and hand back the
 * interceptor that was registered.
 *
 * @returns The registered pass-through interceptor.
 */
function registerAndCapture(): PassThroughInterceptor {
  const server = {} as unknown as Mockttp;
  registerSwapInterceptor(server);
  const interceptor = (server as unknown as Record<string, unknown>)
    .__passThroughInterceptor as PassThroughInterceptor | undefined;
  if (!interceptor) {
    throw new Error('registerSwapInterceptor did not register an interceptor');
  }
  return interceptor;
}

/**
 * Let every already-queued microtask run.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Assert that a result is a Promise that stays pending until exactly
 * `delayMs` of fake time has elapsed, and return what it resolves to.
 *
 * @param result - What the interceptor returned.
 * @param delayMs - The delay the result is expected to wait out.
 * @returns The resolved interceptor result.
 */
async function resolveAfterDelay(
  result: ReturnType<PassThroughInterceptor>,
  delayMs: number,
): Promise<PassThroughInterceptorResult> {
  expect(result).toBeInstanceOf(Promise);
  const promise = result as Promise<PassThroughInterceptorResult>;

  let settled = false;
  const tracked = promise.then((value) => {
    settled = true;
    return value;
  });

  jest.advanceTimersByTime(delayMs - 1);
  await flushMicrotasks();
  expect(settled).toBe(false);

  jest.advanceTimersByTime(1);
  await flushMicrotasks();
  expect(settled).toBe(true);

  return tracked;
}

/**
 * Assert that a result came back synchronously rather than as a Promise.
 *
 * @param result - What the interceptor returned.
 * @returns The same result, narrowed to the non-Promise branch.
 */
function expectNotDelayed(
  result: ReturnType<PassThroughInterceptor>,
): PassThroughInterceptorResult {
  expect(result).not.toBeInstanceOf(Promise);
  return result as PassThroughInterceptorResult;
}

describe('swap-mocks quote delay knob', () => {
  const originalEnvValue = process.env[QUOTE_DELAY_ENV_VAR];

  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env[QUOTE_DELAY_ENV_VAR];
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalEnvValue === undefined) {
      delete process.env[QUOTE_DELAY_ENV_VAR];
    } else {
      process.env[QUOTE_DELAY_ENV_VAR] = originalEnvValue;
    }
  });

  describe('with no delay configured', () => {
    it('serves getQuoteStream synchronously', () => {
      const interceptor = registerAndCapture();

      const result = expectNotDelayed(
        interceptor({ url: SSE_URL, method: 'GET' }),
      );

      expect(result?.response).toMatchObject({
        statusCode: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
      expect(typeof result?.response.body).toBe('string');
    });

    it('serves getQuote synchronously', () => {
      const interceptor = registerAndCapture();

      const result = expectNotDelayed(
        interceptor({ url: REST_URL, method: 'GET' }),
      );

      expect(result?.response).toMatchObject({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
      });
      expect(Array.isArray(result?.response.json)).toBe(true);
    });

    it('leaves the non-quote endpoints untouched', () => {
      const interceptor = registerAndCapture();

      for (const url of [FEATURE_FLAGS_URL, CLIENT_CONFIG_URL, SOLANA_URL]) {
        const result = expectNotDelayed(interceptor({ url, method: 'GET' }));
        expect(result?.response).toBeDefined();
      }

      expect(
        expectNotDelayed(interceptor({ url: UNMATCHED_URL, method: 'GET' })),
      ).toBeNull();
    });
  });

  describe('with a delay configured', () => {
    beforeEach(() => {
      process.env[QUOTE_DELAY_ENV_VAR] = String(DELAY_MS);
    });

    // Both quote endpoints must be delayed. The extension takes the
    // getQuote REST path when the SSE feature flag or version check does
    // not pass in the build under test, so delaying only getQuoteStream
    // is a silent no-op on those builds.
    it('delays getQuoteStream', async () => {
      const interceptor = registerAndCapture();

      const result = await resolveAfterDelay(
        interceptor({ url: SSE_URL, method: 'GET' }),
        DELAY_MS,
      );

      expect(result?.response).toMatchObject({
        statusCode: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    it('delays getQuote', async () => {
      const interceptor = registerAndCapture();

      const result = await resolveAfterDelay(
        interceptor({ url: REST_URL, method: 'GET' }),
        DELAY_MS,
      );

      expect(result?.response).toMatchObject({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    it('does not delay the feature-flag, client-config or Solana endpoints', () => {
      const interceptor = registerAndCapture();

      for (const url of [FEATURE_FLAGS_URL, CLIENT_CONFIG_URL, SOLANA_URL]) {
        expectNotDelayed(interceptor({ url, method: 'GET' }));
      }
    });

    it('serves the same payloads it serves with no delay', async () => {
      delete process.env[QUOTE_DELAY_ENV_VAR];
      const undelayed = registerAndCapture();
      const undelayedRest = expectNotDelayed(
        undelayed({ url: REST_URL, method: 'GET' }),
      );

      process.env[QUOTE_DELAY_ENV_VAR] = String(DELAY_MS);
      const delayed = registerAndCapture();
      const delayedRest = await resolveAfterDelay(
        delayed({ url: REST_URL, method: 'GET' }),
        DELAY_MS,
      );

      expect(delayedRest?.response.json).toStrictEqual(
        undelayedRest?.response.json,
      );
      expect(delayedRest?.response.statusCode).toStrictEqual(
        undelayedRest?.response.statusCode,
      );
    });

    it('reads the environment once at registration, not per request', async () => {
      const interceptor = registerAndCapture();

      process.env[QUOTE_DELAY_ENV_VAR] = '9999';

      await resolveAfterDelay(
        interceptor({ url: SSE_URL, method: 'GET' }),
        DELAY_MS,
      );
    });
  });

  describe('readQuoteDelayMs', () => {
    it('returns 0 when the variable is absent', () => {
      expect(readQuoteDelayMs()).toBe(0);
    });

    // `it.each` is unavailable here: `test/e2e` is typed for mocha, whose
    // `TestFunction` has no `.each`, so this loops instead.
    for (const [value, description] of UNUSABLE_DELAY_VALUES) {
      it(`returns 0 for "${value}" (${description})`, () => {
        process.env[QUOTE_DELAY_ENV_VAR] = value;
        expect(readQuoteDelayMs()).toBe(0);
      });
    }

    it('warns when the variable is set but unusable', () => {
      process.env[QUOTE_DELAY_ENV_VAR] = 'abc';

      readQuoteDelayMs();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(QUOTE_DELAY_ENV_VAR),
      );
    });

    it('is silent when the variable is absent', () => {
      readQuoteDelayMs();

      expect(console.warn).not.toHaveBeenCalled();
    });

    it('returns the parsed value for a positive number', () => {
      process.env[QUOTE_DELAY_ENV_VAR] = '538';
      expect(readQuoteDelayMs()).toBe(538);
    });
  });

  describe('a malformed value leaves the default path intact', () => {
    it('serves both quote endpoints synchronously', () => {
      process.env[QUOTE_DELAY_ENV_VAR] = 'not-a-number';
      const interceptor = registerAndCapture();

      expectNotDelayed(interceptor({ url: SSE_URL, method: 'GET' }));
      expectNotDelayed(interceptor({ url: REST_URL, method: 'GET' }));
    });
  });
});
