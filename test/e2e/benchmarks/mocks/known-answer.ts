/**
 * Known-answer delays: an extra, fixed delay on one mocked response, so a
 * check can confirm that the step waiting on that response grows by exactly
 * that much. Each response has its own environment variable, read when its
 * mock is registered; unset or empty, it is 0 and the mock behaves as before.
 */

/** Delays the quote responses `fetchAndDisplaySwapQuotes` waits on. */
export const KNOWN_ANSWER_QUOTE_DELAY = 'BENCHMARK_KNOWN_ANSWER_QUOTE_DELAY_MS';

/**
 * Delays the Solana `getLatestBlockhash` response, which the review step
 * (`reviewTransactionToConfirmationPage`) waits on before the confirmation.
 */
export const KNOWN_ANSWER_SOLANA_BLOCKHASH_DELAY =
  'BENCHMARK_KNOWN_ANSWER_SOLANA_BLOCKHASH_DELAY_MS';

/**
 * Delays the bridge token-search response, which `bridge_search_token` waits
 * on before the matching row.
 */
export const KNOWN_ANSWER_TOKEN_SEARCH_DELAY =
  'BENCHMARK_KNOWN_ANSWER_TOKEN_SEARCH_DELAY_MS';

/**
 * Delays the v3 historical-prices response, which the asset page's price chart
 * needs before it renders `asset-price-percent-change`.
 */
export const KNOWN_ANSWER_HISTORICAL_PRICES_DELAY =
  'BENCHMARK_KNOWN_ANSWER_HISTORICAL_PRICES_DELAY_MS';

/**
 * Read a known-answer delay.
 *
 * @param name - The environment variable that holds it.
 * @returns The delay in milliseconds, or 0 when unset or empty.
 */
export function getKnownAnswerDelayMs(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return 0;
  }
  const delayMs = Number(raw);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return delayMs;
}

/**
 * Wrap a mock's handler so that its response waits the known-answer delay
 * first. The delay is added as given, and not zeroed with the fixture's own
 * delays (`BENCHMARK_ZERO_MOCK_DELAYS`, `BENCHMARK_ZERO_MOCK_DELAY_SET`), so it
 * applies in either arm. That holds only where the wrapper sits outside the
 * fixture's delayed handler, as in
 * `withKnownAnswerDelay(name, delayedResponse(...))`.
 *
 * @param name - The environment variable that holds the delay.
 * @param handler - The mock's handler.
 * @returns The handler, delayed when the variable is set above 0.
 */
export function withKnownAnswerDelay<TRequest, TResponse>(
  name: string,
  handler: (request: TRequest) => TResponse | Promise<TResponse>,
): (request: TRequest) => Promise<TResponse> {
  const delayMs = getKnownAnswerDelayMs(name);
  return async (request) => {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return handler(request);
  };
}
