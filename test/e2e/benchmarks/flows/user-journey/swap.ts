/**
 * Benchmark: Swap flow performance
 * Measures time for swap flow including quote fetching
 */

import type { Mockttp } from 'mockttp';
import { generateWalletState } from '../../../../../app/scripts/fixtures/generate-wallet-state';
import { ALL_POPULAR_NETWORKS } from '../../../../../app/scripts/fixtures/with-networks';
import { withFixtures } from '../../../helpers';
import type { MockedEndpoint } from '../../../mock-e2e';
import { login } from '../../../page-objects/flows/login.flow';
import TokensTab from '../../../page-objects/pages/home/tokens-tab';
import HomePage from '../../../page-objects/pages/home/homepage';
import SwapPage from '../../../page-objects/pages/swap/swap-page';
import { Driver } from '../../../webdriver/driver';
import { collectTimerResults } from '../../utils/timer-helper';
import {
  sentryCountResult,
  sentryTimerResult,
  waitForSentryTransactions,
} from '../../utils/sentry-transactions';
import { TraceName } from '../../../../../shared/lib/trace';
import {
  measureStepWithLongTasks,
  buildLongTaskTimerResults,
} from '../../utils/long-task-helper';
import {
  getTestSpecificMock,
  shouldUseMockedRequests,
} from '../../utils/mock-config';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
  type WebVitalsMetrics,
} from '../../../../../shared/constants/benchmarks';
import { WITH_STATE_POWER_USER } from '../../utils/constants';
import { collectWebVitals } from '../../utils';
import type {
  BenchmarkRunResult,
  LongTaskStepResult,
  TimerResult,
} from '../../utils/types';
import { registerSwapInterceptor } from '../../mocks/swap-mocks';

export const testTitle = 'benchmark-swap-power-user';
export const persona = BENCHMARK_PERSONA.POWER_USER;
const SOLANA_USDC_CONTRACT_ADDRESS =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

export async function runSwapBenchmark(): Promise<BenchmarkRunResult> {
  const steps: LongTaskStepResult[] = [];
  const traceTimers: TimerResult[] = [];
  let webVitals: WebVitalsMetrics | undefined;
  try {
    const branchMock = getTestSpecificMock();

    await withFixtures(
      {
        title: testTitle,
        fixtures: (await generateWalletState(WITH_STATE_POWER_USER, true))
          .withEnabledNetworks(ALL_POPULAR_NETWORKS)
          .build(),
        manifestFlags: {
          testing: {
            infuraProjectId: process.env.INFURA_PROJECT_ID,
          },
          // Sample every trace, so the swap spans reach the mocked Sentry
          // endpoint this benchmark reads them from. CI builds otherwise send
          // only a small fraction of traces.
          sentry: { tracesSampleRate: 1 },
        },
        useMockingPassThrough: !shouldUseMockedRequests(),
        disableServerMochaToBackground: true,
        extendedTimeoutMultiplier: 3,
        testSpecificMock: async (
          mockServer: Mockttp,
        ): Promise<MockedEndpoint[]> => {
          // In pass-through mode (main/release branches), register
          // interceptors inside the single thenPassThrough handler.
          if (!shouldUseMockedRequests()) {
            registerSwapInterceptor(mockServer);
          }

          // On PR branches, register the full mock suite
          const branchEndpoints = branchMock
            ? await branchMock(mockServer)
            : [];
          return [...branchEndpoints];
        },
      },
      async ({
        driver,
        mockedEndpoint,
      }: {
        driver: Driver;
        mockedEndpoint: MockedEndpoint[];
      }) => {
        // Login flow
        await login(driver, { validateBalance: false });
        const homePage = new HomePage(driver);
        const tokensTab = new TokensTab(driver);
        await tokensTab.checkTokenListIsDisplayed();
        await tokensTab.waitForTokenToBeDisplayed('Ethereum');

        // Wait for Solana balance to load before starting the swap flow
        if (shouldUseMockedRequests()) {
          await tokensTab.checkTokenAmountIsDisplayed('50 SOL');
        } else {
          await tokensTab.waitForTokenToBeDisplayed('SOL');
        }

        // Measure: Open swap page
        await homePage.startSwapFlow();
        steps.push(
          await measureStepWithLongTasks(
            driver,
            'openSwapPageFromHome',
            async () => {
              const swapPage = new SwapPage(driver);
              await swapPage.checkPageIsLoaded();
            },
          ),
        );

        // Measure: Fetch quotes
        const swapPage = new SwapPage(driver);
        await swapPage.createSwap({
          amount: 0.01,
          swapTo: 'USDC',
          swapToContractAddress: SOLANA_USDC_CONTRACT_ADDRESS,
          swapFrom: 'SOL',
          network: 'Solana',
        });

        steps.push(
          await measureStepWithLongTasks(
            driver,
            'fetchAndDisplaySwapQuotes',
            async () => {
              await swapPage.checkQuoteIsDisplayed({ timeout: 60000 });
            },
          ),
        );

        // The app's own spans over the same two steps, as the Sentry SDK sent
        // them, timed on the browser's clock (extension#46006). Report-only:
        // no threshold is registered for them.
        // 30s rather than the 10s default: the control arm of the V14 run
        // returned an empty entry because `Swap Quote Fetch` had not reached
        // the mock inside 10s, which is a property of the flush rather than of
        // the span. Raised in both arms so they still differ by one variable.
        //
        // Under the fixture a second `Swap Quote Fetch` is expected, and the
        // wait has to require it: without a per-name count it returns as soon
        // as one of each name is present and the count reads 1 either way.
        const transactions = await waitForSentryTransactions(
          driver,
          mockedEndpoint,
          [TraceName.SwapViewLoaded, TraceName.SwapQuoteFetch],
          {
            timeoutMs: 30000,
            ...(process.env.BENCHMARK_V14_INJECT === 'swap-quote'
              ? { expected: { [TraceName.SwapQuoteFetch]: 2 } }
              : {}),
          },
        );
        // DIAGNOSTIC ORDER, deliberate. `sentryTimerResult` throws on an absent
        // trace and `runner.ts` discards the whole iteration on a throw, so the
        // artifact has never been able to say WHICH of the two traces arrived --
        // only that something was missing. Counts first and unconditionally, then
        // the durations behind a catch, so a run where `Swap Quote Fetch` never
        // arrives still reports `swapQuoteFetchCount: 0` beside
        // `swapViewLoadedCount: 1` instead of an empty entry.
        traceTimers.push(
          sentryCountResult(
            transactions,
            TraceName.SwapViewLoaded,
            'swapViewLoadedCount',
          ),
          sentryCountResult(
            transactions,
            TraceName.SwapQuoteFetch,
            'swapQuoteFetchCount',
          ),
        );

        for (const [name, id] of [
          [TraceName.SwapViewLoaded, 'swapViewLoaded'],
          [TraceName.SwapQuoteFetch, 'swapQuoteFetch'],
        ] as const) {
          try {
            traceTimers.push(sentryTimerResult(transactions, name, id));
          } catch (error) {
            console.log(
              `[benchmark] ${id} unavailable: ${(error as Error).message}`,
            );
          }
        }

        try {
          webVitals = await collectWebVitals(driver);
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }
      },
    );

    return {
      timers: [
        ...collectTimerResults(),
        ...buildLongTaskTimerResults(steps),
        ...traceTimers,
      ],
      webVitals,
      success: true,
      benchmarkType: BENCHMARK_TYPE.PERFORMANCE,
    };
  } catch (error) {
    return {
      timers: [
        ...collectTimerResults(),
        ...buildLongTaskTimerResults(steps),
        ...traceTimers,
      ],
      webVitals,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      benchmarkType: BENCHMARK_TYPE.PERFORMANCE,
    };
  }
}

export const run = runSwapBenchmark;
