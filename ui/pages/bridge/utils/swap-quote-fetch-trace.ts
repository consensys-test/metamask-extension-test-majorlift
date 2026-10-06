import { v4 as uuidv4 } from 'uuid';
import {
  formatChainIdToCaip,
  type GenericQuoteRequest,
  type QuoteStreamCompleteReason,
} from '@metamask/bridge-controller';
import {
  endTrace,
  trace,
  TraceName,
  TraceOperation,
} from '../../../../shared/lib/trace';

export type SwapQuoteFetchTraceResult =
  | 'success'
  | 'cancelled'
  | 'no_quotes'
  | 'error';

let activeTraceId: string | undefined;

/**
 * `performance.now()` when the active span opened, for the long-task overlap below.
 */
let activeTraceStartMs: number | undefined;

/**
 * Milliseconds of main-thread long task that fell INSIDE this span.
 *
 * The excursion measured on 2026-10-06 is a ~3% per-iteration event worth +60 to
 * +280 ms. Seven of ten cases coincided with a long task of 51-66 ms and three
 * carried none, but the artifact records long tasks as a per-RUN aggregate, so
 * whether the task fell inside the span or merely in the same iteration was not
 * decidable -- and neither was the direction, since a long task could delay the
 * span's end or be produced by whatever slowed it.
 *
 * The observer already keeps per-task `startTime` and `duration`; nothing exports
 * them. This computes the overlap with the span's own interval at close time, so
 * the answer rides the span that raised the question.
 */
function longTaskOverlapMs(startMs: number, endMs: number): number {
  const hooks = (
    globalThis as unknown as {
      stateHooks?: {
        getLongTaskMetricsWithTBT?: () => {
          observed?: boolean;
          tasks?: { startTime: number; duration: number }[];
        };
      };
    }
  ).stateHooks;
  const m = hooks?.getLongTaskMetricsWithTBT?.();
  // Gate on `observed`: outside Chromium the hook returns initialised zeros and an
  // empty task list, which is absent rather than quiet.
  if (!m?.observed || !m.tasks) {
    return -1;
  }
  return m.tasks.reduce((acc, t) => {
    const lo = Math.max(t.startTime, startMs);
    const hi = Math.min(t.startTime + t.duration, endMs);
    return acc + Math.max(hi - lo, 0);
  }, 0);
}

/**
 * Milliseconds to busy-wait inside the span before closing it, for the
 * admission gate's app-side known-answer arm. The mock-side delay
 * (`BENCHMARK_KNOWN_ANSWER_QUOTE_DELAY_MS`) slows the quote RESPONSE, and the
 * span absorbs the first ~180 ms of that because the app is not waiting on it
 * yet. This slows the app's own work INSIDE the span, which is on the critical
 * path by construction, so the two arms separate "the span cannot see a small
 * regression" from "the span cannot see a small regression in response latency".
 *
 * A busy-wait rather than an awaited timer: a real regression occupies the main
 * thread, and awaiting would yield it and measure something else.
 *
 * Read at webpack build time, like `SENTRY_SAMPLE_RATE_OVERRIDES`. A page
 * global does not work here: `driver.executeScript` writes the page realm and
 * this module does not share it, which an arm on 2026-10-02 established by
 * reading `98` back from the page while the module read nothing.
 */
const INJECTED_SPAN_DELAY_MS = Number(
  process.env.BENCHMARK_APP_SPAN_DELAY_MS ?? 0,
);

/**
 * When the quote response's first byte arrived, as an offset from the span's start.
 *
 * The excursion is now known not to be in-span main-thread blocking, a uniform
 * mock delay, a shared slowdown, machine speed, or a restarted trace. What is left
 * splits in two and this separates them: if the first byte arrives late, the wait
 * grew; if it arrives on time and the span is still long, the cost is after the
 * response and before the effect's gate is satisfied.
 *
 * `responseStart`, not `responseEnd`: the endpoint is `getQuoteStream`, an SSE
 * response, so the stream closes well after the first quote the span ends on.
 *
 * Three sentinels, because a zero here has three meanings and only one is a
 * measurement:
 *   -1  no matching resource entry inside the span
 *   -2  an entry, but `responseStart` is 0 -- cross-origin timing is not exposed
 *       without `Timing-Allow-Origin`, and the mock serves a different origin
 *   >=0 the offset in milliseconds
 */
/**
 * How many resource entries the UI realm recorded inside the span, at all.
 *
 * `quoteResponseStartOffsetMs` returned -1 on every sample of both browsers, and -1
 * has two causes that look identical: the entry is absent because the fetch happens
 * in another realm, or it is present under a name the regex missed. The code settles
 * where the fetch runs -- `callBridgeControllerMethod` dispatches into a background
 * controller -- but it does not settle whether the UI realm fetches anything else
 * during the span, and only the second case would mean the filter is at fault.
 *
 * A count discriminates them without carrying names out: zero means the UI realm
 * issued no requests at all while the span was open, which is the structural reading;
 * nonzero means entries existed and none of them matched.
 */
function resourceEntriesInSpan(startMs: number, endMs: number): number {
  try {
    return (
      performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    ).filter((e) => e.startTime >= startMs && e.startTime <= endMs).length;
  } catch {
    return -1;
  }
}

function quoteResponseStartOffsetMs(startMs: number, endMs: number): number {
  let found: PerformanceResourceTiming | undefined;
  try {
    const entries = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
    for (const e of entries) {
      if (
        e.startTime >= startMs &&
        e.startTime <= endMs &&
        /getQuote/u.test(e.name)
      ) {
        found = e;
      }
    }
  } catch {
    return -1;
  }
  if (!found) {
    return -1;
  }
  if (!found.responseStart) {
    return -2;
  }
  return found.responseStart - startMs;
}

const finishTrace = (
  result: SwapQuoteFetchTraceResult,
  id: string | undefined = activeTraceId,
  reason?: QuoteStreamCompleteReason,
): void => {
  if (!id || activeTraceId !== id) {
    return;
  }

  // Do not collapse to an unconditional loop. Unset, the env var inlines to a
  // falsy literal (`builds.yml` defaults it to null) and this drops out.
  if (INJECTED_SPAN_DELAY_MS > 0) {
    const until = Date.now() + INJECTED_SPAN_DELAY_MS;
    while (Date.now() < until) {
      // Occupying the main thread is the point: see INJECTED_SPAN_DELAY_MS.
    }
  }

  const overlapMs =
    activeTraceStartMs === undefined
      ? -1
      : longTaskOverlapMs(activeTraceStartMs, performance.now());

  endTrace({
    name: TraceName.SwapQuoteFetch,
    id,
    timestamp: Date.now(),
    data: {
      result,
      /* eslint-disable @typescript-eslint/naming-convention -- Sentry trace attributes use snake_case */
      // -1 means the observer never attached, which is not the same as zero overlap.
      long_task_ms_in_span: overlapMs,
      quote_response_start_offset_ms:
        activeTraceStartMs === undefined
          ? -1
          : quoteResponseStartOffsetMs(activeTraceStartMs, performance.now()),
      resource_entries_in_span:
        activeTraceStartMs === undefined
          ? -1
          : resourceEntriesInSpan(activeTraceStartMs, performance.now()),
      /* eslint-enable @typescript-eslint/naming-convention */
      ...(result === 'no_quotes' || result === 'error'
        ? {
            /* eslint-disable @typescript-eslint/naming-convention -- Sentry trace attributes use snake_case */
            no_quote_reason: reason ?? 'generic_error',
            /* eslint-enable @typescript-eslint/naming-convention */
          }
        : {}),
    },
  });
  activeTraceId = undefined;
  activeTraceStartMs = undefined;
};

export const swapQuoteFetchTrace = {
  start({
    srcChainId,
    destChainId,
    isRefresh,
  }: {
    srcChainId?: GenericQuoteRequest['srcChainId'];
    destChainId?: GenericQuoteRequest['destChainId'];
    isRefresh: boolean;
  }): string {
    if (activeTraceId) {
      finishTrace('cancelled');
    }

    const id = uuidv4();
    const srcChainIdInCaip = srcChainId
      ? formatChainIdToCaip(srcChainId)
      : undefined;
    const destChainIdInCaip = destChainId
      ? formatChainIdToCaip(destChainId)
      : undefined;
    let swapType: 'single_chain' | 'crosschain' | undefined;
    if (srcChainIdInCaip && destChainIdInCaip) {
      swapType =
        srcChainIdInCaip === destChainIdInCaip ? 'single_chain' : 'crosschain';
    }

    trace({
      name: TraceName.SwapQuoteFetch,
      op: TraceOperation.BridgeDataFetch,
      id,
      data: {
        /* eslint-disable @typescript-eslint/naming-convention -- Sentry trace attributes use snake_case */
        request_id: id,
        isRefresh,
        ...(swapType && { swap_type: swapType }),
        ...(srcChainIdInCaip && { src_chain_id: srcChainIdInCaip }),
        ...(destChainIdInCaip && { dest_chain_id: destChainIdInCaip }),
        /* eslint-enable @typescript-eslint/naming-convention */
      },
      startTime: Date.now(),
    });
    activeTraceId = id;
    activeTraceStartMs = performance.now();
    return id;
  },

  finish(
    result: SwapQuoteFetchTraceResult,
    id?: string,
    reason?: QuoteStreamCompleteReason,
  ): void {
    finishTrace(result, id, reason);
  },
};
