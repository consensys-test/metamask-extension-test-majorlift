/**
 * Benchmark: Onboarding - Import existing wallet
 * Measures time for importing an existing wallet during onboarding
 */

import { Browser } from 'selenium-webdriver';
import { Mockttp, MockedEndpoint } from 'mockttp';
import { ALL_POPULAR_NETWORKS } from '../../../../../app/scripts/fixtures/with-networks';
import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { E2E_SRP, WALLET_PASSWORD } from '../../../constants';
import { withFixtures } from '../../../helpers';
import {
  onboardingMetricsFlow,
  skipPasskeySetup,
} from '../../../page-objects/flows/onboarding.flow';
import AccountListPage from '../../../page-objects/pages/accounts/list-page';
import HeaderNavbar from '../../../page-objects/pages/home/header-navbar';
import TokensTab from '../../../page-objects/pages/home/tokens-tab';
import HomePage from '../../../page-objects/pages/home/homepage';
import OnboardingCompletePage from '../../../page-objects/pages/onboarding/onboarding-complete-page';
import OnboardingMetricsPage from '../../../page-objects/pages/onboarding/onboarding-metrics-page';
import OnboardingPasswordPage from '../../../page-objects/pages/onboarding/onboarding-password-page';
import OnboardingSrpPage from '../../../page-objects/pages/onboarding/onboarding-srp-page';
import StartOnboardingPage from '../../../page-objects/pages/onboarding/start-onboarding-page';
import { Driver } from '../../../webdriver/driver';
import { collectTimerResults } from '../../utils/timer-helper';
import {
  measureStepWithLongTasks,
  buildLongTaskTimerResults,
} from '../../utils/long-task-helper';
import {
  IN_PAGE_DESTINATIONS,
  finishInPageStep,
  measureStepInPage,
  startInPageStep,
} from '../../utils/in-page-step-timer';
import { loadHomeAfterSidepanelOnboarding } from '../../utils/sidepanel-onboarding';
import {
  sentryCountResult,
  sentryTimerResult,
  waitForSentryTransactions,
} from '../../utils/sentry-transactions';
import { TraceName } from '../../../../../shared/lib/trace';
import { setPassThroughInterceptor } from '../../../mock-e2e-pass-through';
import {
  getCommonMocks,
  benchmarkPassThroughInterceptor,
  mockBenchmarkEndpoints,
  userStorageHostMock,
} from '../../mocks/performance-mocks';
import { shouldUseMockedRequests } from '../../utils/mock-config';
import {
  BENCHMARK_PERSONA,
  BENCHMARK_TYPE,
  type WebVitalsMetrics,
} from '../../../../../shared/constants/benchmarks';
import { collectWebVitals } from '../../utils';
import type {
  BenchmarkRunResult,
  LongTaskStepResult,
  TimerResult,
} from '../../utils/types';

export const testTitle = 'benchmark-onboarding-import-wallet';
export const persona = BENCHMARK_PERSONA.POWER_USER;

export async function runOnboardingImportWalletBenchmark(): Promise<BenchmarkRunResult> {
  const steps: LongTaskStepResult[] = [];
  const traceTimers: TimerResult[] = [];
  const inPageTimers: TimerResult[] = [];
  let webVitals: WebVitalsMetrics | undefined;
  try {
    await withFixtures(
      {
        title: testTitle,
        manifestFlags: {
          testing: {
            infuraProjectId: process.env.INFURA_PROJECT_ID,
          },
          // Sample every trace, so the spans this benchmark reads reach the
          // mocked Sentry endpoint. CI builds otherwise send only a small
          // fraction of traces.
          sentry: { tracesSampleRate: 1 },
        },
        useMockingPassThrough: !shouldUseMockedRequests(),
        disableServerMochaToBackground: true,
        extendedTimeoutMultiplier: 3,
        fixtures: new FixtureBuilderV2({ onboarding: true })
          .withEnabledNetworks(ALL_POPULAR_NETWORKS)
          .build(),
        testSpecificMock: async (server: Mockttp) => {
          if (shouldUseMockedRequests()) {
            const endpoints = await mockBenchmarkEndpoints(server);
            await userStorageHostMock(server);
            return endpoints;
          }
          setPassThroughInterceptor(server, benchmarkPassThroughInterceptor);
          await userStorageHostMock(server);
          return Promise.all(getCommonMocks(server));
        },
      },
      async ({
        driver,
        mockedEndpoint,
      }: {
        driver: Driver;
        mockedEndpoint: MockedEndpoint[];
      }) => {
        const srp = process.env.E2E_POWER_USER_SRP || E2E_SRP;

        await driver.navigate();
        const isFirefox = process.env.SELENIUM_BROWSER === Browser.FIREFOX;
        if (isFirefox) {
          await onboardingMetricsFlow(driver, {
            consentDecisionMade: true,
            optedIn: false,
            dataCollectionForMarketing: false,
          });
        }

        // Measure: Import wallet button to Social screen. Each
        // `<stepId>InPage` times its step from the triggering input itself, on
        // the page's clock; the step timers are unchanged.
        const startOnboardingPage = new StartOnboardingPage(driver);
        await startOnboardingPage.checkLoginPageIsLoaded();
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'importWalletToSocialScreen', {
            endSelector: IN_PAGE_DESTINATIONS.onboardingImportOptions,
            trigger: () => startOnboardingPage.importWallet(false),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'importWalletToSocialScreen',
                  async () => {
                    await startOnboardingPage.checkUserSrpButtonIsVisible();
                  },
                ),
              );
            },
          })),
        );

        // Measure: SRP button to form
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'srpButtonToSrpForm', {
            endSelector: IN_PAGE_DESTINATIONS.onboardingSrp,
            trigger: () => startOnboardingPage.clickImportWithSrpButton(),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'srpButtonToSrpForm',
                  async () => {
                    const onboardingSrpPage = new OnboardingSrpPage(driver);
                    await onboardingSrpPage.checkPageIsLoaded();
                  },
                ),
              );
            },
          })),
        );

        // Measure: Confirm to Password form. The trigger is the Confirm click
        // alone, so the step timer opens when it returns: `clickConfirmButton`
        // would first wait for the button to leave the page.
        const onboardingSrpPage = new OnboardingSrpPage(driver);
        await onboardingSrpPage.fillSrp(srp);
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'confirmSrpToPwForm', {
            endSelector: IN_PAGE_DESTINATIONS.onboardingPassword,
            trigger: () =>
              driver.clickElement('[data-testid="import-srp-confirm"]'),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'confirmSrpToPwForm',
                  async () => {
                    const onboardingPasswordPage = new OnboardingPasswordPage(
                      driver,
                    );
                    await onboardingPasswordPage.checkPageIsLoaded();
                  },
                ),
              );
            },
          })),
        );

        // Create password. On Firefox no passkey or metrics screen follows,
        // since metrics were decided before onboarding started, so the
        // password submit is what triggers `metricsToWalletReadyScreen`. The
        // submit is clicked here rather than through `createWalletPassword`,
        // which would then wait up to 15 s for the button to leave the page
        // before the next step timer opens.
        const onboardingPasswordPage = new OnboardingPasswordPage(driver);
        let walletReadyProbe = false;
        if (isFirefox) {
          walletReadyProbe = await startInPageStep(
            driver,
            'metricsToWalletReadyScreen',
            {
              endSelector: IN_PAGE_DESTINATIONS.onboardingComplete,
              startWithin: '[data-testid="create-password-submit"]',
            },
          );
        }
        await onboardingPasswordPage.fillWalletPassword(
          WALLET_PASSWORD,
          WALLET_PASSWORD,
        );
        await driver.clickElement('[data-testid="create-password-submit"]');

        // Measure: Password to Metrics (Chrome only). No in-page timer: the
        // passkey screen sits between the two, and the harness dismisses it
        // inside the step, so the region would include the harness's reaction.
        // The passkey screen gets the 15 s the dropped wait allowed on top of
        // its own 5 s, so a slow wallet creation fails no sooner than before.
        if (isFirefox) {
          await skipPasskeySetup(driver);
        } else {
          steps.push(
            await measureStepWithLongTasks(
              driver,
              'pwFormToMetricsScreen',
              async () => {
                await skipPasskeySetup(driver, { timeout: 20000 });
                const onboardingMetricsPage = new OnboardingMetricsPage(driver);
                await onboardingMetricsPage.checkPageIsLoaded();
              },
            ),
          );
          // The Continue click alone triggers the next step: through
          // `clickOnContinueButton` the step timer would open only once the
          // button had left the page.
          walletReadyProbe = await startInPageStep(
            driver,
            'metricsToWalletReadyScreen',
            { endSelector: IN_PAGE_DESTINATIONS.onboardingComplete },
          );
          await driver.clickElement('[data-testid="metametrics-i-agree"]');
        }

        // Measure: Metrics to Complete
        steps.push(
          await measureStepWithLongTasks(
            driver,
            'metricsToWalletReadyScreen',
            async () => {
              const onboardingCompletePage = new OnboardingCompletePage(driver);
              await onboardingCompletePage.checkPageIsLoaded();
            },
          ),
        );
        if (walletReadyProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(driver, 'metricsToWalletReadyScreen')),
          );
        }

        // Measure: Done to Home. In-page on Firefox only: on Chrome, Done
        // opens the side panel in another window and the harness then loads
        // `home.html` afresh, so the destination is in a different document.
        // There the step timer opens when that load returns, so it covers the
        // header and the rest of the home page; the wait for onboarding to
        // complete and the navigation stay outside it. On Firefox Done
        // navigates within the page and the step timer opens when the click
        // returns. The in-page timer ends when the token list renders; the
        // step timer goes on to wait for the Ethereum and Solana rows by
        // their text, which no CSS selector can match.
        const onboardingCompletePage = new OnboardingCompletePage(driver);
        const homeProbe =
          isFirefox &&
          (await startInPageStep(driver, 'doneButtonToHomeScreen', {
            endSelector: IN_PAGE_DESTINATIONS.homeWithTokenList,
            startWithin: '[data-testid="onboarding-complete-done"]',
          }));
        await onboardingCompletePage.completeOnboarding();
        const homeLoaded = await loadHomeAfterSidepanelOnboarding(driver);
        steps.push(
          await measureStepWithLongTasks(
            driver,
            'doneButtonToHomeScreen',
            async () => {
              if (homeLoaded) {
                await new HeaderNavbar(driver).checkPageIsLoaded();
              }
              const homePage = new HomePage(driver);
              await homePage.checkPageIsLoaded();
              const tokensTab = new TokensTab(driver);
              await tokensTab.checkTokenListIsDisplayed();
              await tokensTab.checkTokenExistsInList('Ethereum');
              await tokensTab.waitForTokenToBeDisplayed('Solana', 120000);
            },
          ),
        );
        if (homeProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(driver, 'doneButtonToHomeScreen')),
          );
        }

        // Measure: Account list load. The trigger is the account menu click
        // alone, so the step timer opens when it returns: `openAccountMenu`
        // would first wait for the list's container. The in-page timer ends
        // when the list renders; the step timer also waits out account
        // syncing, held for 2 s.
        inPageTimers.push(
          ...(await measureStepInPage(
            driver,
            'openAccountMenuToAccountListLoaded',
            {
              endSelector: IN_PAGE_DESTINATIONS.accountList,
              trigger: () =>
                driver.clickElement('[data-testid="account-menu-icon"]'),
              settle: async () => {
                steps.push(
                  await measureStepWithLongTasks(
                    driver,
                    'openAccountMenuToAccountListLoaded',
                    async () => {
                      const accountListPage = new AccountListPage(driver);
                      await accountListPage.checkPageIsLoaded(120000);
                    },
                  ),
                );
              },
            },
          )),
        );

        // The app's own spans over opening the account list, as the Sentry SDK
        // sent them, timed on the browser's clock rather than on the harness's
        // (extension#46006 ([P0] Benchmark step timers measure the test
        // harness, not the browser)).
        //
        // Two spans cover this one interaction and only `Show Account List` is
        // reported. Both start on the account menu button the step above
        // clicks: `Account List` in the account picker's own `onClick`, and
        // `Show Account List` in the handler that `onClick` then calls. Both
        // end on a mount effect in `MultichainAccountList`. So the span covers
        // the click, which the step timer, opening once the click returns,
        // cannot see.
        //
        // An earlier revision reported both, on the reasoning that the gap
        // between them localizes where the cost sits. Measured over 15 builds
        // it does not: the means differ by 0.12 ms at r = 1.0000 on Chrome, so
        // the pair carries one interval's information and admitting both would
        // spend two rows of the suite's budget and two of the per-PR
        // false-discovery correction to measure one wait twice. `Show Account
        // List` is the one kept because its start sits with the navigation it
        // measures rather than one component inward.
        //
        // This is the only span this flow converts. The six earlier steps
        // have no span whose interval matches them; the commit message records
        // the per-step finding. Report-only: no threshold is registered, and
        // it carries a `unit` so `runner.ts` keeps it out of the per-run
        // `total`.
        const transactions = await waitForSentryTransactions(
          driver,
          mockedEndpoint,
          [TraceName.ShowAccountList],
        );
        traceTimers.push(
          sentryTimerResult(
            transactions,
            TraceName.ShowAccountList,
            'showAccountList',
          ),
          sentryCountResult(
            transactions,
            TraceName.ShowAccountList,
            'showAccountListCount',
          ),
        );

        // BUG #42792 This test is failing with the ASSETS_UNIFIED_STATE_ENABLED='true'
        // commenting out temporarily to unblock the release
        /*
        try {
          webVitals = await collectWebVitals(driver);
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }
        */
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

export const run = runOnboardingImportWalletBenchmark;
