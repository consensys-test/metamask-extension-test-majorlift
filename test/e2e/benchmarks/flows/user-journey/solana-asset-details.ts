/**
 * Benchmark: Solana asset details page load for power user
 * Measures time to load price chart for SOL token
 */

import { generateWalletState } from '../../../../../app/scripts/fixtures/generate-wallet-state';
import { ALL_POPULAR_NETWORKS } from '../../../../../app/scripts/fixtures/with-networks';
import { withFixtures } from '../../../helpers';
import type { MockedEndpoint } from '../../../mock-e2e';
import { login } from '../../../page-objects/flows/login.flow';
import TokensTab from '../../../page-objects/pages/home/tokens-tab';
import { Driver } from '../../../webdriver/driver';
import { collectTimerResults } from '../../utils/timer-helper';
import {
  describeSpanBreakdown,
  readSentryTransactions,
  sentryCountResult,
  sentryTimerResult,
  waitForSentryTransactions,
} from '../../utils/sentry-transactions';
import { TraceName } from '../../../../../shared/lib/trace';
import {
  measureStepWithLongTasks,
  buildLongTaskTimerResults,
} from '../../utils/long-task-helper';
import { measureStepInPage } from '../../utils/in-page-step-timer';
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

const SOL_TOKEN_ADDRESS = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501';

/**
 * The price chart's own data: the percent change in the chart header. The
 * chart passes the header a comparison price only once non-placeholder
 * historical prices have loaded (`asset-chart.tsx`, `comparePrice`), and the
 * header renders this element only when that yields a percentage
 * (`token-price-header.tsx`). Scoped to the asset page, so it is absent until
 * the click. It needs the historical-prices mock to match the URL the chart
 * requests; without a matching response the chart never gets data and this
 * element never appears.
 */
const PRICE_CHART_DATA =
  '[data-testid="parent-selector-asset-details"] [data-testid="asset-price-percent-change"]';

export const testTitle = 'benchmark-solana-asset-details-power-user';
export const persona = BENCHMARK_PERSONA.POWER_USER;

export async function runSolanaAssetDetailsBenchmark(): Promise<BenchmarkRunResult> {
  const steps: LongTaskStepResult[] = [];
  const traceTimers: TimerResult[] = [];
  const inPageTimers: TimerResult[] = [];
  let webVitals: WebVitalsMetrics | undefined;
  try {
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
          // Sample every trace, so the `Asset Details` span reaches the mocked
          // Sentry endpoint this benchmark reads it from. CI builds otherwise
          // send only a small fraction of traces.
          sentry: { tracesSampleRate: 1 },
        },
        useMockingPassThrough: !shouldUseMockedRequests(),
        disableServerMochaToBackground: true,
        extendedTimeoutMultiplier: 3,
        testSpecificMock: getTestSpecificMock(),
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
        const tokensTab = new TokensTab(driver);
        await tokensTab.checkTokenListIsDisplayed();

        // Measure: Asset click to the price chart's data. Both timers end at
        // `PRICE_CHART_DATA`, not at the asset page's first render, which is
        // where the chart container and the balance row's percentage already
        // are. `clickOnAsset` may first expand the low-value section, so the
        // in-page timer starts only on input inside a token row.
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'assetClickToPriceChart', {
            endSelector: PRICE_CHART_DATA,
            startWithin: '[data-testid="multichain-token-list-button"]',
            trigger: () => tokensTab.clickOnAsset('Solana'),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'assetClickToPriceChart',
                  async () => {
                    await tokensTab.checkPriceChartIsShown();
                    await driver.waitForSelector(PRICE_CHART_DATA);
                  },
                ),
              );
            },
          })),
        );

        // The app's own span over this journey, as the Sentry SDK sent it,
        // timed on the browser's clock (extension#46006 ([P0] Benchmark step
        // timers measure the test harness, not the browser)).
        //
        // `Asset Details` is NOT coextensive with `assetClickToPriceChart`:
        // it runs from `onTokenClick` to the asset page's mount, BEFORE the
        // price chart's historical-price data has rendered, where the step
        // timers end. It therefore measures navigation only, and is reported
        // under its own id rather than as a replacement for the step timer.
        // Report-only: no threshold is registered for it.
        const transactions = await waitForSentryTransactions(
          driver,
          mockedEndpoint,
          [TraceName.AssetDetails],
        );
        traceTimers.push(
          sentryTimerResult(
            transactions,
            TraceName.AssetDetails,
            'assetDetails',
          ),
          sentryCountResult(
            transactions,
            TraceName.AssetDetails,
            'assetDetailsCount',
          ),
        );

        try {
          webVitals = await collectWebVitals(driver);
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }

        // Diagnostic, not a series: the child spans inside this iteration's
        // `Asset Details` span, from every transaction the mocked Sentry
        // endpoint has captured by now, so a slow iteration's job log shows
        // where inside the span the time went. Read last, after every
        // measurement, so a navigation span that ends later is more likely
        // to have been sent.
        try {
          console.log(
            `[benchmark] ${describeSpanBreakdown(
              await readSentryTransactions(mockedEndpoint),
              TraceName.AssetDetails,
            )}`,
          );
        } catch (error) {
          console.error('Error reading the Asset Details child spans:', error);
        }
      },
    );

    return {
      timers: [
        ...collectTimerResults(),
        ...buildLongTaskTimerResults(steps),
        ...traceTimers,
        ...inPageTimers,
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
        ...inPageTimers,
      ],
      webVitals,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      benchmarkType: BENCHMARK_TYPE.PERFORMANCE,
    };
  }
}

export const run = runSolanaAssetDetailsBenchmark;
