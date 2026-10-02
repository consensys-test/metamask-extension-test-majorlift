/**
 * Swap benchmark mock setup for pass-through mode.
 *
 * In mockttp's HTTPS proxy mode, separate mock rules (`.forGet()`,
 * `.matching()`, `.thenStream()`, etc.) do NOT intercept proxied
 * HTTPS requests. The only reliable interception point is the
 * `beforeRequest` callback inside the single `thenPassThrough()`
 * handler registered by `setupMockingPassThrough`.
 *
 * This module registers a pass-through interceptor that mocks the
 * specific URLs needed for the swap benchmark while letting
 * everything else pass through to real servers.
 */

import type { Mockttp } from 'mockttp';
import {
  setPassThroughInterceptor,
  type PassThroughInterceptorResult,
} from '../../mock-e2e-pass-through';
import {
  BRIDGE_FEATURE_FLAGS,
  CLIENT_CONFIG_FLAGS,
  solanaGetBalanceResponse,
} from './mock-responses';
import swapQuoteSolUsdc from './swap-quote-sol-usdc.json';

/**
 * Build a static SSE response body from an array of quote events.
 *
 * @param events - Quote payloads to include
 * @returns SSE-formatted string body
 */
export function buildSseResponseBody(events: unknown[]): string {
  return events
    .map(
      (quote, i) =>
        `event: quote\nid: ${Date.now()}-${i + 1}\ndata: ${JSON.stringify(quote)}\n\n`,
    )
    .join('');
}

/**
 * Name of the environment variable that injects an artificial delay
 * into the mocked quote responses.
 */
export const QUOTE_DELAY_ENV_VAR = 'BENCHMARK_KNOWN_ANSWER_QUOTE_DELAY_MS';

/**
 * Read the injected quote delay from the environment.
 *
 * Absent, unparseable or non-positive values all mean no delay, so the
 * default path is unchanged for every run that does not set the
 * variable — the same mocks serve the A/A window these runs are
 * compared against. A value that is set but unusable is warned about
 * rather than silently dropped: a typo would otherwise produce a
 * known-answer run that injects nothing and reads as the decision rule
 * failing to detect a regression.
 *
 * `Number` is used rather than `parseInt` so that a trailing-garbage
 * value like `538ms` is rejected instead of being read as 538.
 *
 * @returns The delay in milliseconds, or 0 for no delay.
 */
export function readQuoteDelayMs(): number {
  const raw = process.env[QUOTE_DELAY_ENV_VAR];
  if (raw === undefined || raw === '') {
    return 0;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[swap-mocks] ignoring ${QUOTE_DELAY_ENV_VAR}="${raw}" — expected a positive number of milliseconds. No delay will be injected.`,
    );
    return 0;
  }

  return parsed;
}

/**
 * Register a pass-through interceptor that mocks specific URLs
 * needed for the swap benchmark while letting everything else
 * pass through to real servers.
 *
 * @param mockServer - The Mockttp server instance
 */
export function registerSwapInterceptor(mockServer: Mockttp): void {
  const sseBody = buildSseResponseBody([swapQuoteSolUsdc]);

  // Read once at registration rather than per request, so every quote
  // in a run is delayed by the same amount.
  const quoteDelayMs = readQuoteDelayMs();
  if (quoteDelayMs > 0) {
    console.log(
      `[swap-mocks] injecting ${quoteDelayMs}ms delay into getQuoteStream and getQuote`,
    );
  }

  /**
   * Hold a quote response back by the configured delay.
   *
   * Both quote endpoints get the same treatment. The SSE branch is not
   * actually streamed here — `buildSseResponseBody` serialises every
   * event into one `text/event-stream` body that is returned in a
   * single response — so for this mock there is no gap between
   * first-event and last-event to preserve, and delaying the response
   * delays the whole body for both branches alike. If the SSE mock is
   * ever converted to a real `thenStream`, this delay has to move to
   * before the first event is written instead.
   *
   * With no delay configured the response is returned synchronously,
   * so the default path does not even allocate a Promise.
   *
   * @param result - The interceptor result to delay.
   * @returns The result, or a Promise of it when a delay is configured.
   */
  function withQuoteDelay(
    result: PassThroughInterceptorResult,
  ): PassThroughInterceptorResult | Promise<PassThroughInterceptorResult> {
    if (quoteDelayMs <= 0) {
      return result;
    }
    return new Promise((resolve) => {
      setTimeout(() => resolve(result), quoteDelayMs);
    });
  }

  setPassThroughInterceptor(mockServer, (req) => {
    if (req.url.includes('solana-mainnet.infura.io')) {
      return { response: solanaGetBalanceResponse() };
    }

    // Bridge feature flags (enables SSE + Solana chain)
    if (req.url.includes('bridge.api.cx.metamask.io/featureFlags')) {
      return {
        response: {
          statusCode: BRIDGE_FEATURE_FLAGS.statusCode,
          headers: { 'content-type': 'application/json' },
          json: BRIDGE_FEATURE_FLAGS.json,
        },
      };
    }

    // Client-config feature flags (enables SSE + Solana chain)
    if (req.url.includes('client-config.api.cx.metamask.io/v1/flags')) {
      return {
        response: {
          statusCode: CLIENT_CONFIG_FLAGS.statusCode,
          headers: { 'content-type': 'application/json' },
          json: CLIENT_CONFIG_FLAGS.json,
        },
      };
    }

    // getQuoteStream SSE endpoint
    if (req.url.includes('getQuoteStream')) {
      return withQuoteDelay({
        response: {
          statusCode: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: sseBody,
        },
      });
    }

    // getQuote REST endpoint (non-SSE fallback) — the extension may
    // use getQuote instead of getQuoteStream when the SSE feature
    // flag or version check does not pass in the current build.
    if (
      req.url.includes('bridge.api.cx.metamask.io/getQuote') &&
      !req.url.includes('getQuoteStream')
    ) {
      return withQuoteDelay({
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          json: [swapQuoteSolUsdc],
        },
      });
    }

    // Not handled by this interceptor
    return null;
  });
}
