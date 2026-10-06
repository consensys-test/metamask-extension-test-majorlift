import type { MockedEndpoint } from 'mockttp';
import type { TraceName } from '../../../../shared/lib/trace';
import type { Driver } from '../../webdriver/driver';
import type { TimerResult } from './types';

const SENTRY_ENVELOPE_URL = /sentry\.io\/api\/\d+\/envelope/u;

/**
 * One transaction as the Sentry SDK sent it.
 */
export type SentryTransaction = {
  name: string;
  durationMs: number;
  endTimestamp: number;
  success: boolean;
  /**
   * The span's whole `data`, so a numeric field the app attached can be read back
   * without adding a named property here per diagnostic. `result` and `isRefresh`
   * below stay as named fields because callers branch on them.
   */
  data?: Record<string, unknown>;
  /**
   * The outcome the app recorded via `endTrace`'s `data.result`, where the
   * trace sets one. `success` does not capture it: a trace ended as
   * `cancelled` carries an ok status and an undefined `data.success`, so it
   * reads as successful and its duration is not the duration of a completed
   * operation.
   */
  result?: string;
  /**
   * The `isRefresh` attribute the trace set when it started, where it sets
   * one. `swapQuoteFetchTrace.start` passes it, and `startSpan` forwards the
   * start `data` as span attributes exactly as `endTrace` does for `result`,
   * so it arrives on the same `contexts.trace.data` path this parser already
   * reads `result` from.
   */
  isRefresh?: boolean;
};

type TransactionPayload = {
  transaction?: string;
  // eslint-disable-next-line @typescript-eslint/naming-convention
  start_timestamp?: number;
  timestamp?: number;
  contexts?: {
    trace?: {
      status?: string;
      data?: { success?: unknown; result?: unknown; isRefresh?: unknown };
    };
  };
};

/**
 * Parse the transaction items out of one Sentry envelope body.
 *
 * An envelope is newline-delimited JSON: an envelope header, then an item
 * header and a payload for each item. Items other than transactions are
 * skipped.
 *
 * @param body - The envelope body as the SDK sent it.
 * @returns The transactions in the envelope, in item order.
 */
export function parseEnvelopeTransactions(body: string): SentryTransaction[] {
  const lines = body.split('\n');
  const transactions: SentryTransaction[] = [];
  let index = 1;
  while (index + 1 < lines.length) {
    let itemType: unknown;
    try {
      itemType = JSON.parse(lines[index]).type;
    } catch {
      index += 1;
      continue;
    }
    if (itemType === 'transaction') {
      try {
        const payload = JSON.parse(lines[index + 1]) as TransactionPayload;
        const { transaction, timestamp } = payload;
        const startTimestamp = payload.start_timestamp;
        if (
          typeof transaction === 'string' &&
          typeof timestamp === 'number' &&
          typeof startTimestamp === 'number'
        ) {
          const trace = payload.contexts?.trace;
          transactions.push({
            name: transaction,
            // Envelope timestamps are in seconds.
            durationMs: (timestamp - startTimestamp) * 1000,
            endTimestamp: timestamp,
            success:
              trace?.data?.success !== false &&
              (trace?.status === undefined || trace.status === 'ok'),
            ...(typeof trace?.data?.result === 'string' && {
              result: trace.data.result,
            }),
            ...(typeof trace?.data?.isRefresh === 'boolean' && {
              isRefresh: trace.data.isRefresh,
            }),
            ...(trace?.data && { data: trace.data }),
          });
        }
      } catch {
        // A payload that is not JSON is not a transaction we can read.
      }
    }
    index += 2;
  }
  return transactions;
}

/**
 * Read every transaction the Sentry SDK has sent to the mocked Sentry
 * endpoint so far. The benchmark mocks intercept these requests, so nothing
 * reaches a real Sentry project.
 *
 * @param endpoints - The mocked endpoints for this benchmark run.
 * @returns The transactions, ordered by when each ended.
 */
export async function readSentryTransactions(
  endpoints: MockedEndpoint[],
): Promise<SentryTransaction[]> {
  const transactions: SentryTransaction[] = [];
  for (const endpoint of endpoints) {
    for (const request of await endpoint.getSeenRequests()) {
      if (SENTRY_ENVELOPE_URL.test(request.url)) {
        transactions.push(
          ...parseEnvelopeTransactions((await request.body.getText()) ?? ''),
        );
      }
    }
  }
  return transactions.sort((a, b) => a.endTimestamp - b.endTimestamp);
}

/**
 * Wait until a transaction for every named trace has been sent, or until the
 * timeout passes. The SDK sends a transaction when its span ends, so this
 * covers the delivery delay rather than the measured work.
 *
 * @param driver - The WebDriver instance, used to wait between reads.
 * @param endpoints - The mocked endpoints for this benchmark run.
 * @param names - The traces that must have been sent.
 * @param timeoutMs - How long to wait before returning what has arrived.
 * @returns The transactions read on the last attempt.
 */
export async function waitForSentryTransactions(
  driver: Driver,
  endpoints: MockedEndpoint[],
  names: TraceName[],
  {
    timeoutMs = 10000,
    expected = {},
  }: {
    timeoutMs?: number;
    expected?: Partial<Record<TraceName, number>>;
  } = {},
): Promise<SentryTransaction[]> {
  const pollMs = 250;
  let transactions = await readSentryTransactions(endpoints);
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    // Count instances, not names. Breaking on name-presence returns as soon as
    // one transaction of each name has arrived, so a caller expecting a second
    // occurrence of the same trace reads whatever happened to have flushed --
    // which makes a count-based known-answer check a race rather than a check.
    const enough = names.every(
      (name) =>
        transactions.filter((transaction) => transaction.name === name)
          .length >= (expected[name] ?? 1),
    );
    if (enough) {
      break;
    }
    await driver.delay(pollMs);
    transactions = await readSentryTransactions(endpoints);
  }
  return transactions;
}

/**
 * Turn the last sent transaction of a trace into a benchmark timer.
 *
 * An absent or failed measurement throws, so the iteration fails with the
 * trace named instead of the value dropping out of the sample.
 *
 * @param transactions - Transactions read by {@link readSentryTransactions}.
 * @param name - The trace to read.
 * @param id - The benchmark metric id to report it under.
 * @returns The timer result for the last transaction.
 */
export function sentryTimerResult(
  transactions: SentryTransaction[],
  name: TraceName,
  id: string,
): TimerResult {
  const matching = transactions.filter(
    (transaction) => transaction.name === name,
  );
  const last = matching[matching.length - 1];

  if (!last) {
    throw new Error(
      `Trace "${name}" was not sent to Sentry, so "${id}" has no value`,
    );
  }
  if (!last.success) {
    throw new Error(
      `Trace "${name}" last completed unsuccessfully, so "${id}" is not a timing`,
    );
  }
  // A trace that records its own outcome must have completed, not been
  // cancelled or errored. `success` cannot see this: the outcome lives in
  // `data.result` and a cancelled span still carries an ok status.
  if (last.result !== undefined && last.result !== 'success') {
    throw new Error(
      `Trace "${name}" last completed as "${last.result}", so "${id}" is not a timing`,
    );
  }

  // Tagged with a unit so the runner leaves it out of the per-run `total`,
  // which sums only untagged timers: the spans overlap the step timers, and
  // adding both would count the same time twice.
  return { id, value: last.durationMs, unit: 'ms' };
}

/**
 * The same timing, but over the trace's FIRST non-refresh completion rather
 * than its last completion of any kind.
 *
 * `sentryTimerResult` takes `matching[matching.length - 1]`, so its value
 * depends on how many times the trace ran. Measured on `Swap Quote Fetch`,
 * a second fetch is **113.97 ms faster on Chrome and 110.67 on Firefox**
 * (`release/aa-v14-*` against the 30-run A/A window), which is 2.5x the
 * gate's `delta_block`. A flow change that merely adds a refresh therefore
 * moves the metric further than the rule blocks at, downward, resetting the
 * baseline without firing.
 *
 * The initial fetch is the one a user waits on when the page opens; a
 * refresh happens while quotes are already on screen. Where no transaction
 * carries the attribute this falls back to the same span
 * `sentryTimerResult` would have picked, so a trace that does not set
 * `isRefresh` behaves exactly as before.
 *
 * @param transactions - Transactions read by {@link readSentryTransactions}.
 * @param name - The trace to time.
 * @param id - The benchmark metric id to report it under.
 * @returns The initial completion's duration as a timer result.
 */
export function sentryInitialTimerResult(
  transactions: SentryTransaction[],
  name: TraceName,
  id: string,
): TimerResult {
  const matching = transactions.filter(
    (transaction) => transaction.name === name,
  );
  const initial = matching.find(
    (transaction) => transaction.isRefresh === false,
  );
  if (!initial) {
    return sentryTimerResult(transactions, name, id);
  }
  if (!initial.success) {
    throw new Error(
      `Trace "${name}" initial completion was unsuccessful, so "${id}" is not a timing`,
    );
  }
  if (initial.result !== undefined && initial.result !== 'success') {
    throw new Error(
      `Trace "${name}" initial completion was "${initial.result}", so "${id}" is not a timing`,
    );
  }
  return { id, value: initial.durationMs, unit: 'ms' };
}

/**
 * Report how many times a trace was sent. A trace restarted by user input
 * completes more than once, and a change in that count changes what the last
 * duration covers.
 *
 * @param transactions - Transactions read by {@link readSentryTransactions}.
 * @param name - The trace to count.
 * @param id - The benchmark metric id to report it under.
 * @returns The count as a timer result.
 */
export function sentryCountResult(
  transactions: SentryTransaction[],
  name: TraceName,
  id: string,
): TimerResult {
  return {
    id,
    value: transactions.filter((transaction) => transaction.name === name)
      .length,
    unit: 'count',
  };
}


/**
 * Read a numeric field the app attached to a span's `data` and report it as a timer.
 *
 * Added for `long_task_ms_in_span`. The excursion in `swapQuoteFetch` coincided with
 * a main-thread long task in 7 of 10 cases, but the artifact's long-task figures are
 * per-RUN aggregates, so neither containment nor direction was decidable: a task in
 * the same iteration need not fall inside the span, and one that does could be its
 * cause or its consequence. The app now computes the overlap at close time; this
 * carries it back out.
 *
 * Tagged with a unit so `runner.ts` leaves it out of the per-run `total`, which sums
 * only untagged timers -- a millisecond count that is a diagnostic, not a step.
 *
 * @param transactions - Transactions read by {@link readSentryTransactions}.
 * @param name - The trace whose data to read.
 * @param key - The field within that span's `data`.
 * @param id - The benchmark metric id to report it under.
 * @returns The timer result, or null where the field is absent so a caller can omit it.
 */
export function sentryDataResult(
  transactions: SentryTransaction[],
  name: TraceName,
  key: string,
  id: string,
): TimerResult | null {
  const matching = transactions.filter(
    (transaction) => transaction.name === name,
  );
  const last = matching[matching.length - 1];
  const raw = last?.data?.[key];
  if (typeof raw !== 'number') {
    return null;
  }
  return { id, value: raw, unit: 'ms' };
}
