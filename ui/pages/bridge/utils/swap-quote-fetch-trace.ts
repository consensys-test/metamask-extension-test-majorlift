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

  endTrace({
    name: TraceName.SwapQuoteFetch,
    id,
    timestamp: Date.now(),
    data: {
      result,
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
