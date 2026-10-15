/**
 * Benchmark: Send transaction flow performance
 * Measures time for send flow from opening send page to confirmation
 */

import { generateWalletState } from '../../../../../app/scripts/fixtures/generate-wallet-state';
import { ALL_POPULAR_NETWORKS } from '../../../../../app/scripts/fixtures/with-networks';
import { withFixtures } from '../../../helpers';
import { login } from '../../../page-objects/flows/login.flow';
import AccountListPage from '../../../page-objects/pages/accounts/list-page';
import HeaderNavbar from '../../../page-objects/pages/home/header-navbar';
import TokensTab from '../../../page-objects/pages/home/tokens-tab';
import SnapTransactionConfirmation from '../../../page-objects/pages/confirmations/snap-transaction-confirmation';
import HomePage from '../../../page-objects/pages/home/homepage';
import SendPage from '../../../page-objects/pages/send/send-page';
import { Driver } from '../../../webdriver/driver';
import { collectTimerResults } from '../../utils/timer-helper';
import {
  measureStepWithLongTasks,
  buildLongTaskTimerResults,
} from '../../utils/long-task-helper';
import {
  IN_PAGE_DESTINATIONS,
  measureStepInPage,
} from '../../utils/in-page-step-timer';
import { waitDismissingOptionalDialog } from '../../utils/optional-dialog';
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

const RECIPIENT_ADDRESS = 'GxSJqxAyTjCjyDmPxdBBfVE9QwuMhEoHrPLRTmMyqxnU';

/** `SendPage`'s Continue button. */
const SEND_CONTINUE_BUTTON = '[data-testid="send-continue-button"]';

/** The acknowledge button of `SendPage`'s first-time-recipient alert. */
const SEND_ALERT_ACKNOWLEDGE_BUTTON =
  '[data-testid="send-alert-modal-acknowledge-button"]';

export const testTitle = 'benchmark-send-transactions-power-user';
export const persona = BENCHMARK_PERSONA.POWER_USER;

export async function runSendTransactionsBenchmark(): Promise<BenchmarkRunResult> {
  const steps: LongTaskStepResult[] = [];
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
        },
        useMockingPassThrough: !shouldUseMockedRequests(),
        disableServerMochaToBackground: true,
        extendedTimeoutMultiplier: 3,
        testSpecificMock: getTestSpecificMock(),
      },
      async ({ driver }: { driver: Driver }) => {
        // Login flow
        await login(driver, { validateBalance: false });
        const homePage = new HomePage(driver);
        const tokensTab = new TokensTab(driver);
        await tokensTab.checkTokenListIsDisplayed();
        const accountListPage = new AccountListPage(driver);
        const headerNavbar = new HeaderNavbar(driver);
        await headerNavbar.openAccountMenu();
        await accountListPage.switchToAccount('Account 1');
        // Wait for Solana balance to load before starting the send flow
        if (shouldUseMockedRequests()) {
          await tokensTab.checkTokenAmountIsDisplayed('50 SOL');
        } else {
          await tokensTab.waitForTokenToBeDisplayed('SOL');
        }

        // Measure: Open send page. `<stepId>InPage` times the same step from
        // the click itself, on the page's clock; the step timer is unchanged.
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'openSendPageFromHome', {
            endSelector: IN_PAGE_DESTINATIONS.sendNetworkFilter,
            trigger: () => homePage.startSendFlow(),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'openSendPageFromHome',
                  async () => {
                    const sendPage = new SendPage(driver);
                    await sendPage.checkNetworkFilterToggleIsDisplayed();
                  },
                ),
              );
            },
          })),
        );

        // Measure: Select token and load form
        const sendPage = new SendPage(driver);
        inPageTimers.push(
          ...(await measureStepInPage(driver, 'selectTokenToSendFormLoaded', {
            endSelector: IN_PAGE_DESTINATIONS.sendForm,
            trigger: () =>
              sendPage.selectToken(
                'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                'SOL',
              ),
            settle: async () => {
              steps.push(
                await measureStepWithLongTasks(
                  driver,
                  'selectTokenToSendFormLoaded',
                  async () => {
                    await sendPage.checkSendFormIsLoaded();
                  },
                ),
              );
            },
          })),
        );

        // Measure: Review transaction. The trigger is the Continue click, and
        // the step timer opens when it returns: `pressContinueButton` would
        // first spend up to 2 s checking for the first-time-recipient alert.
        // The timed wait watches for that alert while it waits for the
        // confirmation. Without it, the step ends at the confirmation. With
        // it, the harness acknowledges it inside the step, so the step timer
        // includes the harness's reaction, and the in-page timer reports
        // nothing for that iteration because the acknowledgement is a second
        // input.
        await sendPage.fillRecipient({ recipientAddress: RECIPIENT_ADDRESS });
        await sendPage.fillAmount('0.00001');
        let acknowledged = false;
        inPageTimers.push(
          ...(await measureStepInPage(
            driver,
            'reviewTransactionToConfirmationPage',
            {
              endSelector: IN_PAGE_DESTINATIONS.snapConfirmation,
              startWithin: SEND_CONTINUE_BUTTON,
              trigger: async () => {
                await sendPage.waitForContinueButtonStablyEnabled();
                await driver.clickElement(SEND_CONTINUE_BUTTON);
              },
              settle: async () => {
                steps.push(
                  await measureStepWithLongTasks(
                    driver,
                    'reviewTransactionToConfirmationPage',
                    async () => {
                      const confirmation = new SnapTransactionConfirmation(
                        driver,
                      );
                      acknowledged = await waitDismissingOptionalDialog(
                        driver,
                        {
                          destination: () => confirmation.checkPageIsLoaded(),
                          dialogSelector: SEND_ALERT_ACKNOWLEDGE_BUTTON,
                          dismiss: () =>
                            driver.clickElement(SEND_ALERT_ACKNOWLEDGE_BUTTON),
                        },
                      );
                    },
                  ),
                );
                console.log(
                  acknowledged
                    ? 'Acknowledged the send alert modal inside the step'
                    : 'No send alert modal before the confirmation',
                );
              },
            },
          )),
        );

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
        ...inPageTimers,
      ],
      webVitals,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      benchmarkType: BENCHMARK_TYPE.PERFORMANCE,
    };
  }
}

export const run = runSendTransactionsBenchmark;
