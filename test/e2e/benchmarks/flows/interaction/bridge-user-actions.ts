/**
 * Benchmark: Bridge User Actions
 * Measures bridge page load, asset picker load, and token search time
 */

import { Mockttp } from 'mockttp';
import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import BridgeQuotePage from '../../../page-objects/pages/bridge/quote-page';
import HomePage from '../../../page-objects/pages/home/homepage';
import {
  DEFAULT_BRIDGE_FEATURE_FLAGS,
  MOCK_TOKENS_ETHEREUM,
} from '../../../tests/bridge/constants';
import { Driver } from '../../../webdriver/driver';
import { buildLongTaskTimerResults } from '../../utils/long-task-helper';
import {
  IN_PAGE_DESTINATIONS,
  finishInPageStep,
  startInPageStep,
} from '../../utils/in-page-step-timer';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
} from '../../../../../shared/constants/benchmarks';
import { runUserActionBenchmark, collectWebVitals } from '../../utils';
import type {
  BenchmarkRunResult,
  LongTaskStepResult,
  TimerResult,
} from '../../utils/types';

export const testTitle = 'benchmark-user-actions-bridge-user-actions';
export const persona = BENCHMARK_PERSONA.STANDARD;

const FXS_ADDRESS = MOCK_TOKENS_ETHEREUM.find(
  (token) => token.symbol === 'FXS',
)?.address;

async function mockTokensEthereum(mockServer: Mockttp) {
  return await mockServer.forPost(/getTokens\/search/u).thenCallback(() => {
    return {
      statusCode: 200,
      json: {
        data: MOCK_TOKENS_ETHEREUM.map((token) => ({
          ...token,
          assetId: `eip155:1/erc20:${token.address.toLowerCase()}`,
          chainId: 'eip155:1',
        })),
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      },
    };
  });
}

export async function run(): Promise<BenchmarkRunResult> {
  return runUserActionBenchmark(async () => {
    let loadPage: number = 0;
    let loadAssetPicker: number = 0;
    let searchToken: number = 0;
    const steps: LongTaskStepResult[] = [];
    const inPageTimers: TimerResult[] = [];
    let webVitals;

    const fixtureBuilder = new FixtureBuilderV2().withEnabledNetworks({
      eip155: { '0x1': true },
    });

    await withFixtures(
      {
        fixtures: fixtureBuilder.build(),
        disableServerMochaToBackground: true,
        testSpecificMock: mockTokensEthereum,
        title: testTitle,
        manifestFlags: {
          remoteFeatureFlags: {
            bridgeConfig: DEFAULT_BRIDGE_FEATURE_FLAGS,
          },
        },
      },
      async ({ driver }: { driver: Driver }) => {
        await login(driver);
        const homePage = new HomePage(driver);
        const quotePage = new BridgeQuotePage(driver);

        // Each step's in-page probe is installed before its long-task reset,
        // so neither the step's timer nor its long-task window moves. The
        // probes are read after the last step: the first two step timers end
        // at the click, and the next step is what waits for the page, so
        // waiting for it here would shorten the next step's timer.
        const inPageProbes: string[] = [];
        if (
          await startInPageStep(driver, 'bridge_load_page', {
            endSelector: IN_PAGE_DESTINATIONS.swapPage,
          })
        ) {
          inPageProbes.push('bridge_load_page');
        }
        await driver.resetLongTaskMetrics();
        const timestampBeforeLoadPage = new Date();
        await homePage.startSwapFlow();
        const timestampAfterLoadPage = new Date();
        loadPage =
          timestampAfterLoadPage.getTime() - timestampBeforeLoadPage.getTime();
        let longTaskData = await driver.collectLongTaskMetrics();
        steps.push({
          id: 'bridge_load_page',
          duration: loadPage,
          longTaskCount: longTaskData?.count ?? 0,
          longTaskTotalDuration: longTaskData?.totalDuration ?? 0,
          longTaskMaxDuration: longTaskData?.maxDuration ?? 0,
          tbt: longTaskData?.tbt ?? 0,
          longTasksObserved: longTaskData?.observed ?? false,
        });

        if (
          await startInPageStep(driver, 'bridge_load_asset_picker', {
            endSelector: IN_PAGE_DESTINATIONS.bridgeAssetPicker,
          })
        ) {
          inPageProbes.push('bridge_load_asset_picker');
        }
        await driver.resetLongTaskMetrics();
        const timestampBeforeClickAssetPicker = new Date();
        await driver.clickElement(quotePage.sourceAssetPickerButton);
        const timestampAfterClickAssetPicker = new Date();
        loadAssetPicker =
          timestampAfterClickAssetPicker.getTime() -
          timestampBeforeClickAssetPicker.getTime();
        longTaskData = await driver.collectLongTaskMetrics();
        steps.push({
          id: 'bridge_load_asset_picker',
          duration: loadAssetPicker,
          longTaskCount: longTaskData?.count ?? 0,
          longTaskTotalDuration: longTaskData?.totalDuration ?? 0,
          longTaskMaxDuration: longTaskData?.maxDuration ?? 0,
          tbt: longTaskData?.tbt ?? 0,
          longTasksObserved: longTaskData?.observed ?? false,
        });

        const tokenToSearch = 'FXS';
        // The search starts on the first character typed: `driver.fill`
        // clears the field with a modifier chord, then waits 200 ms, first.
        // The result row is matched by the address in its asset id, since a
        // CSS selector cannot match the symbol text the step timer waits on.
        if (
          FXS_ADDRESS !== undefined &&
          (await startInPageStep(driver, 'bridge_search_token', {
            endSelector: `[data-testid^="bridge-asset--"][data-testid$="${FXS_ADDRESS}" i]`,
            startWithin: quotePage.assetPrickerSearchInput,
            typedOnly: true,
          }))
        ) {
          inPageProbes.push('bridge_search_token');
        }
        await driver.resetLongTaskMetrics();
        const timestampBeforeTokenSearch = new Date();
        await driver.fill(quotePage.assetPrickerSearchInput, tokenToSearch);
        await driver.waitForSelector({
          text: tokenToSearch,
          css: quotePage.tokenButton,
        });
        const timestampAfterTokenSearch = new Date();
        searchToken =
          timestampAfterTokenSearch.getTime() -
          timestampBeforeTokenSearch.getTime();
        longTaskData = await driver.collectLongTaskMetrics();
        steps.push({
          id: 'bridge_search_token',
          duration: searchToken,
          longTaskCount: longTaskData?.count ?? 0,
          longTaskTotalDuration: longTaskData?.totalDuration ?? 0,
          longTaskMaxDuration: longTaskData?.maxDuration ?? 0,
          tbt: longTaskData?.tbt ?? 0,
          longTasksObserved: longTaskData?.observed ?? false,
        });

        for (const stepId of inPageProbes) {
          inPageTimers.push(...(await finishInPageStep(driver, stepId)));
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
        ...steps.map((s) => ({ id: s.id, value: s.duration })),
        ...buildLongTaskTimerResults(steps),
        ...inPageTimers,
      ],
      webVitals,
    };
  }, BENCHMARK_TYPE.USER_ACTION);
}
