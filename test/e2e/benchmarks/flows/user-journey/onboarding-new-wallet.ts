/**
 * Benchmark: Onboarding - Create new wallet
 * Measures time for creating a new wallet during onboarding
 */

/**
 * Why the six steps below still read the harness clock.
 *
 * `extension#46006 ([P0] Benchmark step timers measure the test harness, not
 * the browser)` asks each step to be measured from the app's own trace span, as
 * the swap flow beside this one does. Every step here was checked and none
 * converts, so none was converted: no span starts and ends on the same app
 * events as its step.
 *
 * That is the bar the swap pilot meets. `TraceName.SwapViewLoaded` starts on
 * the navigation click in `useBridgeNavigation.ts` and ends on page-load-ready
 * in `prepare-bridge-page.tsx`, which are exactly the `openSwapPageFromHome`
 * boundaries.
 *
 * Two things bound what a candidate span can be. A `TraceName` member is only a
 * name: `CreateAccount`, `AddAccount` and `ImportSrp` all read like they belong
 * to a new-wallet flow and all three are declared in `shared/lib/trace.ts` with
 * no `trace` or `endTrace` call site anywhere in `app/`, `ui/` or `shared/`.
 * And the benchmark reads Sentry envelopes, whose transaction items carry only
 * the root span's name, so a span started with a `parentContext` is nested in
 * its parent's payload and cannot be read out by name at all.
 *
 * The onboarding spans that are real carry the
 * `TraceOperation.OnboardingUserJourney` op and bracket runs of steps rather
 * than single steps:
 *
 * `createWalletToSocialScreen` - the `onboarding-create-wallet` click only
 * reveals the login options in `welcome-login.tsx`. Neither boundary is
 * instrumented.
 *
 * `srpButtonToPwForm` - `TraceName.OnboardingNewSrpCreateWallet` starts on
 * exactly this click, in `onCreateClick` in `welcome.tsx`, but ends two steps
 * later at the SRP-backup skip, in `handleRemindLater` in
 * `review-recovery-phrase.tsx`. Nothing ends when the password page loads. The
 * step is bracketed by two instrumented events - that span's start and
 * `TraceName.OnboardingPasswordSetupAttempt`'s start - so it is measurable from
 * inside the browser, but not by any single existing span.
 *
 * `createPwToRecoveryScreen`, named `createPwToPasskeyScreen` on Chrome -
 * `TraceName.OnboardingPasswordSetupAttempt` covers the mount and unmount of
 * `create-password.tsx`. It opens at the previous step's end, so it includes
 * the harness typing the password, which this step does not. It closes on the
 * route change to the passkey screen, which is where this step ends on
 * Chrome.
 *
 * `skipBackupToMetricsScreen` - `handleRemindLater` ends two spans on this
 * click and starts none, and nothing ends when the metrics screen loads.
 *
 * `agreeButtonToOnboardingSuccess` - `metametrics.tsx` and the completion
 * screen carry no trace at all.
 *
 * `doneButtonToAssetList` - on
 * Chrome this timer starts once the harness's navigation to `home.html` has
 * loaded the document, so the startup tree has already started by then:
 * `TraceName.UIStartup` in `app/scripts/ui.ts`, which starts at the
 * navigation's time origin, and `TraceName.SetupStore`,
 * `TraceName.InitialActions` and `TraceName.FirstRender`, which `ui/index.js`
 * starts under `UIStartup` as its children and which are therefore not
 * readable as transactions anyway. `UIStartup` times the harness's
 * navigation, not this step, and with `BENCHMARK_NEW_WALLET_TRACES=1` it is
 * read as `harnessHomeNavigationToUiStartup` at the end of the flow. The only
 * other candidate is `TraceName.AccountOverviewAssetListTab`, which
 * `token-list.tsx` ends here but which `account-overview-tabs.tsx` only ever
 * starts on a tab click, so it is ended without having been started.
 *
 * Two facts gate any future conversion, both from the buffering in
 * `app/scripts/services/sentry/sentry-tracing-service.ts`. Onboarding spans are
 * buffered until the metrics decision, with their `parentContext` stripped. On
 * Chrome the metrics screen is accepted with the participate checkbox at its
 * default, so `trackTracesAfterMetricsOptIn` replays them with their recorded
 * timestamps and each arrives as its own transaction. On Firefox this flow opts
 * out before onboarding starts, so `clearTracesAfterMetricsOptIn` discards
 * every onboarding span and none is ever sent. And that replay happens at
 * `agreeButtonToOnboardingSuccess`, so no onboarding transaction exists before
 * that step whatever the sample rate is.
 *
 * Do not read the existing numbers here as a baseline. The `total` for this
 * flow was a coin flip at a 79% observed failure rate, and `extension#46319
 * (pause startupPowerUserHome and the CUF timing gates)` pauses its gate.
 */

import { Browser } from 'selenium-webdriver';
import type { MockedEndpoint } from 'mockttp';
import { ALL_POPULAR_NETWORKS } from '../../../../../app/scripts/fixtures/with-networks';
import FixtureBuilderV2 from '../../../fixtures/fixture-builder-v2';
import { WALLET_PASSWORD } from '../../../constants';
import { withFixtures } from '../../../helpers';
import {
  onboardingMetricsFlow,
  skipPasskeySetup,
} from '../../../page-objects/flows/onboarding.flow';
import HeaderNavbar from '../../../page-objects/pages/home/header-navbar';
import TokensTab from '../../../page-objects/pages/home/tokens-tab';
import HomePage from '../../../page-objects/pages/home/homepage';
import OnboardingCompletePage from '../../../page-objects/pages/onboarding/onboarding-complete-page';
import OnboardingMetricsPage from '../../../page-objects/pages/onboarding/onboarding-metrics-page';
import OnboardingPasswordPage from '../../../page-objects/pages/onboarding/onboarding-password-page';
import SecureWalletPage from '../../../page-objects/pages/onboarding/secure-wallet-page';
import SetupPasskeyPage from '../../../page-objects/pages/onboarding/setup-passkey-page';
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
import {
  NEW_WALLET_TRACES,
  loadHomeAfterSidepanelOnboarding,
  readCurrentDocumentUiStartup,
  waitForPageIdleBeforeStep,
} from '../../utils/sidepanel-onboarding';
import {
  getTestSpecificMock,
  shouldUseMockedRequests,
} from '../../utils/mock-config';
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

export const testTitle = 'benchmark-onboarding-new-wallet';
export const persona = BENCHMARK_PERSONA.STANDARD;

export async function runOnboardingNewWalletBenchmark(): Promise<BenchmarkRunResult> {
  const steps: LongTaskStepResult[] = [];
  const traceTimers: TimerResult[] = [];
  const inPageTimers: TimerResult[] = [];
  let webVitals: WebVitalsMetrics | undefined;
  // Off unless set to `1`: the flow then samples every trace and reads the
  // app's `UI Startup` span for the home page the harness loads on Chrome.
  // With every trace sampled, the onboarding spans the app replays at the
  // metrics decision, inside the agree step on Chrome, are all sent rather
  // than a sample of them, so it is a switch rather than a default.
  const readTraces = process.env[NEW_WALLET_TRACES] === '1';
  try {
    await withFixtures(
      {
        title: testTitle,
        manifestFlags: {
          testing: {
            infuraProjectId: process.env.INFURA_PROJECT_ID,
          },
          ...(readTraces && { sentry: { tracesSampleRate: 1 } }),
        },
        useMockingPassThrough: !shouldUseMockedRequests(),
        disableServerMochaToBackground: true,
        extendedTimeoutMultiplier: 3,
        fixtures: new FixtureBuilderV2({ onboarding: true })
          .withEnabledNetworks(ALL_POPULAR_NETWORKS)
          .build(),
        testSpecificMock: getTestSpecificMock(),
      },
      async ({
        driver,
        mockedEndpoint,
      }: {
        driver: Driver;
        mockedEndpoint: MockedEndpoint[];
      }) => {
        await driver.navigate();
        const isFirefox = process.env.SELENIUM_BROWSER === Browser.FIREFOX;
        if (isFirefox) {
          await onboardingMetricsFlow(driver, {
            consentDecisionMade: true,
            optedIn: false,
            dataCollectionForMarketing: false,
          });
        }

        // Measure: Create wallet to Social screen. Each in-page timer,
        // `<stepId>`, times its step from the triggering input itself, on the
        // page's clock; the step timers, `<stepId>Legacy`, are unchanged. With
        // `BENCHMARK_PAGE_IDLE_BEFORE_STEP=1` this step and the next start
        // once the page has gone idle, outside both timers.
        const startOnboardingPage = new StartOnboardingPage(driver);
        await startOnboardingPage.checkLoginPageIsLoaded();
        await waitForPageIdleBeforeStep(driver);
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'createWalletToSocialScreen', {
            endSelector: IN_PAGE_DESTINATIONS.onboardingCreateOptions,
            trigger: () => startOnboardingPage.createWalletWithSrp(false),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'createWalletToSocialScreen',
                  async () => {
                    await startOnboardingPage.checkSocialSignUpFormIsVisible();
                  },
                ),
              );
            },
          })),
        );

        // Measure: SRP button to Password form
        await waitForPageIdleBeforeStep(driver);
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'srpButtonToPwForm', {
            endSelector: IN_PAGE_DESTINATIONS.onboardingPassword,
            trigger: () => startOnboardingPage.clickCreateWithSrpButton(),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'srpButtonToPwForm',
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

        // Measure: Password to Recovery. On Chrome the passkey screen comes
        // first, and the harness dismisses it, so there the step ends when
        // the passkey screen has loaded and is named `createPwToPasskeyScreen`:
        // the dismissal, and the recovery screen that follows it, stay outside
        // both timers. On Firefox the step ends at the recovery screen and is
        // named `createPwToRecoveryScreen`. The harness types both fields and
        // ticks the terms before it submits, so the in-page timer starts on
        // the submit click. The submit is clicked here rather than through
        // `createWalletPassword`, which would then wait up to 15 s for the
        // button to leave the page before the step timer opens; the passkey
        // screen gets those 15 s on top of its own 5 s, so a slow wallet
        // creation fails no sooner.
        const onboardingPasswordPage = new OnboardingPasswordPage(driver);
        const passwordStepId = isFirefox
          ? 'createPwToRecoveryScreen'
          : 'createPwToPasskeyScreen';
        const passwordProbe = await startInPageStep(driver, passwordStepId, {
          endSelector: isFirefox
            ? IN_PAGE_DESTINATIONS.onboardingSecureWallet
            : IN_PAGE_DESTINATIONS.setupPasskey,
          startWithin: '[data-testid="create-password-submit"]',
        });
        await onboardingPasswordPage.fillWalletPassword(
          WALLET_PASSWORD,
          WALLET_PASSWORD,
        );
        await driver.clickElement('[data-testid="create-password-submit"]');
        steps.push(
          await measureStepWithLongTasks(driver, passwordStepId, async () => {
            if (isFirefox) {
              await new SecureWalletPage(driver).checkPageIsLoaded();
            } else {
              await new SetupPasskeyPage(driver).checkPageIsLoaded(20000);
            }
          }),
        );
        if (passwordProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(driver, passwordStepId)),
          );
        }
        if (!isFirefox) {
          await skipPasskeySetup(driver);
          await new SecureWalletPage(driver).checkPageIsLoaded();
        }

        // Skip recovery backup. This triggers `skipBackupToMetricsScreen` on
        // Chrome, and `agreeButtonToOnboardingSuccess` on Firefox, where no
        // metrics screen follows because metrics were decided up front.
        const secureWalletPage = new SecureWalletPage(driver);
        const skipBackupProbe = isFirefox
          ? await startInPageStep(driver, 'agreeButtonToOnboardingSuccess', {
              endSelector: IN_PAGE_DESTINATIONS.onboardingComplete,
            })
          : await startInPageStep(driver, 'skipBackupToMetricsScreen', {
              endSelector: IN_PAGE_DESTINATIONS.onboardingMetrics,
            });
        await secureWalletPage.skipSRPBackup();

        // Measure: Skip to Metrics (Chrome only)
        let agreeProbe = isFirefox && skipBackupProbe;
        if (!isFirefox) {
          steps.push(
            await measureStepWithLongTasks(
              driver,
              'skipBackupToMetricsScreen',
              async () => {
                const onboardingMetricsPage = new OnboardingMetricsPage(driver);
                await onboardingMetricsPage.checkPageIsLoaded();
              },
            ),
          );
          if (skipBackupProbe) {
            inPageTimers.push(
              ...(await finishInPageStep(driver, 'skipBackupToMetricsScreen')),
            );
          }
          // The Continue click alone triggers the next step: through
          // `clickOnContinueButton` the step timer would open only once the
          // button had left the page.
          agreeProbe = await startInPageStep(
            driver,
            'agreeButtonToOnboardingSuccess',
            { endSelector: IN_PAGE_DESTINATIONS.onboardingComplete },
          );
          await driver.clickElement('[data-testid="metametrics-i-agree"]');
        }

        // Measure: Agree to Complete
        steps.push(
          await measureStepWithLongTasks(
            driver,
            'agreeButtonToOnboardingSuccess',
            async () => {
              const onboardingCompletePage = new OnboardingCompletePage(driver);
              await onboardingCompletePage.checkPageIsLoaded();
            },
          ),
        );
        if (agreeProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(
              driver,
              'agreeButtonToOnboardingSuccess',
            )),
          );
        }

        // Measure: Done to Asset list. In-page on Firefox only: on Chrome,
        // Done opens the side panel in another window and the harness then
        // loads `home.html` afresh, so the destination is in a different
        // document. There the step timer opens when that load returns, so it
        // covers the header and the rest of the home page; the wait for
        // onboarding to complete and the navigation stay outside it, so on
        // Chrome the step timer starts at that load, not at the Done click.
        // On Firefox Done navigates within the page and the step timer,
        // `doneButtonToAssetListLegacy`, opens when the click returns. The
        // in-page timer ends when the token list renders; the step timer goes
        // on to wait for the Ethereum and Solana rows by their text, which no
        // CSS selector can match.
        const onboardingCompletePage = new OnboardingCompletePage(driver);
        const assetListProbe =
          isFirefox &&
          (await startInPageStep(driver, 'doneButtonToAssetList', {
            endSelector: IN_PAGE_DESTINATIONS.homeWithTokenList,
            startWithin: '[data-testid="onboarding-complete-done"]',
          }));
        await onboardingCompletePage.completeOnboarding();
        const homeLoaded = await loadHomeAfterSidepanelOnboarding(driver);
        steps.push(
          await measureStepWithLongTasks(
            driver,
            'doneButtonToAssetList',
            async () => {
              if (homeLoaded) {
                await new HeaderNavbar(driver).checkPageIsLoaded();
              }
              const homePage = new HomePage(driver);
              await homePage.checkPageIsLoaded();
              const tokensTab = new TokensTab(driver);
              await tokensTab.checkTokenListIsDisplayed();
              await tokensTab.waitForTokenToBeDisplayed('Ethereum');
              await tokensTab.waitForTokenToBeDisplayed('Solana', 60000);
            },
          ),
        );
        if (assetListProbe) {
          inPageTimers.push(
            ...(await finishInPageStep(driver, 'doneButtonToAssetList')),
          );
        }
        // BUG #42792 This test is failing with the ASSETS_UNIFIED_STATE_ENABLED='true'
        // commenting out temporarily to unblock the release
        /*
        try {
          webVitals = await collectWebVitals(driver);
        } catch (error) {
          console.error('Error collecting web vitals:', error);
        }
        */

        // Chrome, with `BENCHMARK_NEW_WALLET_TRACES=1`: the app's `UI Startup`
        // span for the home page the harness loaded after Done, which starts
        // at that navigation and ends once the UI has launched. It is not a
        // step: the harness, not the user, starts it, and the name says so.
        // It is read last, after every timer and after web vitals, so the
        // wait for it changes nothing measured before it. Absent, not zero,
        // when no such span arrives.
        if (homeLoaded && readTraces) {
          traceTimers.push(
            ...(await readCurrentDocumentUiStartup(
              driver,
              mockedEndpoint,
              'harnessHomeNavigationToUiStartup',
            )),
          );
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

export const run = runOnboardingNewWalletBenchmark;
