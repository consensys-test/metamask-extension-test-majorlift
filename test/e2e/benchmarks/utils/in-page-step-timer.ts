import type { Driver } from '../../webdriver/driver';
import type { TimerResult } from './types';

/**
 * In-page step timing.
 *
 * The step timer in `measureStepWithLongTasks` reads the harness clock and,
 * in most journey steps, starts after the click that triggers the step has
 * already returned. This module times the same step a second time, inside the
 * page: from the trusted input event that triggers the step to the moment the
 * destination's key elements are in the DOM, both read with
 * `performance.now()`. The result is reported as `<stepId>InPage` beside the
 * existing timer, which is left exactly as it was, so one run carries both.
 *
 * The end is `performance.now()` in the first `MutationObserver` callback in
 * which every end selector matches. Callbacks run at the first microtask
 * checkpoint after a change, no later than the end of the task that made it,
 * so the end is when that change's script finished; it is not a paint.
 *
 * The test build's LavaMoat scuttling hides most globals from scripts that
 * run in the page outside LavaMoat, as this probe does through
 * `executeScript`. `MutationObserver` is on the test-only part of the
 * exception list in `development/webpack/utils/plugins/LavamoatPlugin/index.ts`
 * for this probe; `setTimeout`, `clearTimeout` and `performance` are on the
 * part every build lists.
 *
 * Observing starts at the triggering input, not at install, and stops at the
 * first match, at the read, or `boundMs` after the trigger, whichever comes
 * first, so no observer outlives its step.
 *
 * An iteration reports nothing for the step, never zero, and logs why, when:
 * - no trusted input reached the trigger after the probe was installed;
 * - the destination was already in the DOM when the trigger fired, so the
 * selector does not distinguish this step's destination;
 * - a further trusted input arrived between the trigger and the destination,
 * so the region contains the harness's own reaction time;
 * - the destination did not appear within the bound, appeared without a DOM
 * change the observer saw, or the probe was lost with its document.
 */

/** How long after its trigger a probe keeps observing for the destination. */
export const IN_PAGE_BOUND_MS = 60_000;

/**
 * The page-side probe's configuration. It crosses `executeScript`, so it must
 * be plain JSON.
 */
export type InPageProbeConfig = {
  stepId: string;
  /** CSS selectors that must all match for the destination to be reached. */
  endSelectors: string[];
  /** When set, only input whose target is inside a match starts the region. */
  startWithin: string | null;
  /** When true, only a keydown that types a character starts the region. */
  typedOnly: boolean;
  /** Stop observing this long after the trigger. */
  boundMs: number;
};

/**
 * One reading of a probe, as {@link readInPageStepProbe} returns it.
 */
export type InPageProbeReading = {
  /** `performance.now()` at the triggering input, or null if none arrived. */
  start: number | null;
  /** `performance.now()` in the first observer callback that matched. */
  end: number | null;
  /** The event type that started the region. */
  startEvent: string | null;
  /** The destination already matched when the triggering input arrived. */
  preexisting: boolean;
  /** Trusted inputs after the trigger and before the destination matched. */
  extraInputs: number;
  /** Observing stopped at the bound without the destination matching. */
  timedOut: boolean;
  /** The destination is in the DOM, but no observer callback recorded it. */
  unobserved: boolean;
};

type InPageProbe = {
  start: number | null;
  end: number | null;
  startEvent: string | null;
  preexisting: boolean;
  extraInputs: number;
  timedOut: boolean;
  matches: () => boolean;
  stop: () => void;
};

type ProbeHost = {
  // A page global the harness owns, named apart from the app's own.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __benchSteps?: Record<string, InPageProbe>;
};

/**
 * Install a probe for one step. Runs in the page.
 *
 * `Driver.executeScript(fn, ...args)` hands `fn` a single argument, the array
 * of `args`, which is why this takes a one-element tuple. The function is
 * serialized into the page, so it must not reference anything outside its own
 * body, and under the test build's LavaMoat scuttling it may use only the
 * globals on that build's exception list, plus `document`.
 *
 * Capture-phase listeners on `document` record the first trusted pointerdown,
 * mousedown, click or keydown that qualifies as the trigger. From then a
 * `MutationObserver` on the whole document checks the end selectors after
 * each batch of changes, and records the time of the first callback in which
 * they all match.
 *
 * @param args - One-element tuple holding the probe configuration.
 * @param args."0" - The probe configuration.
 * @returns Null when installed, or the reason it could not be.
 */
export function installInPageStepProbe([config]: [InPageProbeConfig]):
  | string
  | null {
  const host = window as unknown as ProbeHost;
  const probes = host.__benchSteps ?? {};
  host.__benchSteps = probes;
  probes[config.stepId]?.stop();
  delete probes[config.stepId];

  try {
    for (const selector of config.endSelectors) {
      document.querySelector(selector);
    }
    if (config.startWithin !== null) {
      document.querySelector(config.startWithin);
    }
  } catch (error) {
    return `invalid selector: ${String(error)}`;
  }

  const inputTypes = ['pointerdown', 'mousedown', 'click', 'keydown'];
  let bound: ReturnType<typeof setTimeout> | undefined;

  const matches = (): boolean =>
    config.endSelectors.every(
      (selector) => document.querySelector(selector) !== null,
    );

  const startsRegion = (event: Event): boolean => {
    if (config.startWithin !== null) {
      const { target } = event;
      if (
        !(target instanceof Element) ||
        target.closest(config.startWithin) === null
      ) {
        return false;
      }
    }
    if (config.typedOnly) {
      // A character key, not a modifier chord: `driver.fill` clears the field
      // with Ctrl/Cmd+A and Backspace before it types.
      const { key, ctrlKey, metaKey, altKey } = event as KeyboardEvent;
      return (
        event.type === 'keydown' &&
        typeof key === 'string' &&
        key.length === 1 &&
        !ctrlKey &&
        !metaKey &&
        !altKey
      );
    }
    return true;
  };

  const probe: InPageProbe = {
    start: null,
    end: null,
    startEvent: null,
    preexisting: false,
    extraInputs: 0,
    timedOut: false,
    matches,
    stop: () => undefined,
  };

  let observer: MutationObserver;
  try {
    observer = new MutationObserver(() => {
      if (probe.start === null || probe.end !== null || !matches()) {
        return;
      }
      probe.end = performance.now();
      probe.stop();
    });
  } catch (error) {
    // The build in the browser does not list `MutationObserver` among its
    // scuttling exceptions.
    return `MutationObserver unavailable: ${String(error)}`;
  }

  const onInput = (event: Event): void => {
    if (!event.isTrusted) {
      return;
    }
    if (probe.start === null) {
      if (!startsRegion(event)) {
        return;
      }
      probe.start = performance.now();
      probe.startEvent = event.type;
      if (matches()) {
        probe.preexisting = true;
        probe.stop();
        return;
      }
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      bound = setTimeout(() => {
        probe.timedOut = true;
        probe.stop();
      }, config.boundMs);
      return;
    }
    // One gesture is one pointerdown or one keydown; the mousedown and click
    // that follow a pointerdown belong to it. Typing continues the trigger
    // when the trigger is typed. Input after the destination matched belongs
    // to the next step.
    const anotherGesture =
      event.type === 'pointerdown' ||
      (event.type === 'keydown' && !config.typedOnly);
    if (anotherGesture && probe.end === null) {
      probe.extraInputs += 1;
    }
  };

  probe.stop = () => {
    observer.disconnect();
    if (bound !== undefined) {
      clearTimeout(bound);
      bound = undefined;
    }
    for (const type of inputTypes) {
      document.removeEventListener(type, onInput, true);
    }
  };

  for (const type of inputTypes) {
    document.addEventListener(type, onInput, true);
  }
  probes[config.stepId] = probe;
  return null;
}

/**
 * Read a step's probe and remove it, stopping its observer. Runs in the page.
 *
 * An observer callback runs no later than the end of the task that changed the
 * DOM, so by the time this read runs, in a task of its own, every change made
 * before it has been seen. A destination that matches now with no recorded end appeared
 * without a change the observer reports, and is flagged as `unobserved`.
 *
 * @param args - One-element tuple holding the step id.
 * @param args."0" - The step id the probe was installed under.
 * @returns The reading, or null when no probe exists in this document.
 */
export function readInPageStepProbe([stepId]: [
  string,
]): InPageProbeReading | null {
  const host = window as unknown as ProbeHost;
  const probe = host.__benchSteps?.[stepId];
  if (!probe) {
    return null;
  }
  probe.stop();
  delete host.__benchSteps?.[stepId];
  return {
    start: probe.start,
    end: probe.end,
    startEvent: probe.startEvent,
    preexisting: probe.preexisting,
    extraInputs: probe.extraInputs,
    timedOut: probe.timedOut,
    unobserved:
      probe.start !== null &&
      probe.end === null &&
      !probe.preexisting &&
      probe.matches(),
  };
}

/**
 * Turn a reading into the `<stepId>InPage` timer, or into nothing with the
 * reason logged. Absent, never zero.
 *
 * The value runs from the triggering input to the first observer callback
 * that sees all of the destination's key elements in the DOM, which runs once
 * the script that added the last of them has finished. It includes no paint.
 *
 * Tagged with a unit, as the trace timers in `sentry-transactions.ts` are, so
 * `runner.ts` leaves it out of the per-run `total`, which sums only untagged
 * timers: it overlaps the step timer, and adding both would count the same
 * time twice.
 *
 * @param stepId - The step id the probe was installed under.
 * @param reading - The final reading, or null when no probe was found.
 * @returns The timer, or an empty array.
 */
export function inPageTimerResult(
  stepId: string,
  reading: InPageProbeReading | null,
): TimerResult[] {
  const id = `${stepId}InPage`;
  const absent = (reason: string): TimerResult[] => {
    console.log(`[benchmark] ${id} absent: ${reason}`);
    return [];
  };

  if (reading === null) {
    return absent(
      'no probe in this document; it was not installed, or the page was replaced',
    );
  }
  if (reading.start === null) {
    return absent(
      'no trusted input reached the trigger after the probe was installed',
    );
  }
  if (reading.preexisting) {
    return absent(
      'the destination was already in the DOM when the trigger fired',
    );
  }
  if (reading.extraInputs > 0) {
    return absent(
      `${reading.extraInputs} further trusted input(s) arrived between the trigger and the destination, so the region contains harness time`,
    );
  }
  if (reading.end === null) {
    if (reading.timedOut) {
      return absent('the destination did not appear within the bound');
    }
    return absent(
      reading.unobserved
        ? 'the destination is in the DOM, but no observed DOM change put it there'
        : 'the destination did not appear after the trigger',
    );
  }

  const value = reading.end - reading.start;
  console.log(
    `[benchmark] ${id}: ${value.toFixed(1)} ms from ${reading.startEvent}`,
  );
  return [{ id, value, unit: 'ms' }];
}

export type InPageStepOptions = {
  /**
   * The destination's key element: CSS selectors that must all be in the DOM.
   * Each must be absent when the trigger fires.
   */
  endSelector: string | readonly string[];
  /**
   * Restrict the trigger to input on this element or inside it. Needed when the
   * call that triggers the step makes other inputs first: typing a password
   * before clicking Unlock, or picking tokens before entering an amount.
   */
  startWithin?: string;
  /**
   * Start on the first typed character rather than on any input, so the clear
   * chord `driver.fill` sends first, and the 200 ms it then waits, stay out.
   */
  typedOnly?: boolean;
};

/**
 * Install a probe before a step's trigger runs. A failure is logged and never
 * thrown, so the step's existing timer is unaffected by it.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id; the timer is reported as `<stepId>InPage`.
 * @param options - Where the step ends, and what may start it.
 * @returns Whether the probe was installed.
 */
export async function startInPageStep(
  driver: Driver,
  stepId: string,
  options: InPageStepOptions,
): Promise<boolean> {
  const config: InPageProbeConfig = {
    stepId,
    endSelectors: ([] as string[]).concat(options.endSelector),
    startWithin: options.startWithin ?? null,
    typedOnly: options.typedOnly ?? false,
    boundMs: IN_PAGE_BOUND_MS,
  };
  try {
    const failure = (await driver.executeScript(
      installInPageStepProbe,
      config,
    )) as string | null;
    if (failure !== null) {
      console.log(`[benchmark] ${stepId}InPage not installed: ${failure}`);
      return false;
    }
    return true;
  } catch (error) {
    console.log(
      `[benchmark] ${stepId}InPage not installed: ${(error as Error).message}`,
    );
    return false;
  }
}

/**
 * Read a step's probe once and turn it into its timer. Call it once the
 * step's existing wait has returned. It never waits for a destination that has
 * not appeared. A failure is logged and never thrown.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id the probe was installed under.
 * @returns The `<stepId>InPage` timer, or an empty array.
 */
export async function finishInPageStep(
  driver: Driver,
  stepId: string,
): Promise<TimerResult[]> {
  try {
    const reading = (await driver.executeScript(
      readInPageStepProbe,
      stepId,
    )) as InPageProbeReading | null;
    return inPageTimerResult(stepId, reading);
  } catch (error) {
    console.log(
      `[benchmark] ${stepId}InPage absent: the probe could not be read: ${
        (error as Error).message
      }`,
    );
    return [];
  }
}

/**
 * Time a step inside the page, around its existing harness-clock timer.
 *
 * Installs the probe, runs the trigger, runs `settle` (the step's existing
 * timed wait, unchanged), then reads the probe. The trigger keeps its
 * position relative to the existing timer: it runs before `settle` exactly as
 * it ran before the timed wait. Errors from either are thrown as before.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id; the timer is reported as `<stepId>InPage`.
 * @param options - The probe options, plus the trigger and the timed wait.
 * @param options.trigger - The harness action that starts the step.
 * @param options.settle - The step's existing timed wait.
 * @returns The `<stepId>InPage` timer, or an empty array.
 */
export async function measureStepInPage(
  driver: Driver,
  stepId: string,
  {
    trigger,
    settle,
    ...options
  }: InPageStepOptions & {
    trigger: () => Promise<void>;
    settle: () => Promise<void>;
  },
): Promise<TimerResult[]> {
  const installed = await startInPageStep(driver, stepId, options);
  await trigger();
  await settle();
  return installed ? await finishInPageStep(driver, stepId) : [];
}

/**
 * Destination key elements, as CSS. Each mirrors the CSS part of the
 * page-object method named beside it; text-only locators in those methods
 * have no CSS form and are not represented.
 */
export const IN_PAGE_DESTINATIONS = {
  /** `HomePage.checkPageIsLoaded`. */
  home: ['[data-testid="parent-selector-home"]'],
  /**
   * `HomePage.checkPageIsLoaded` plus `TokensTab.checkTokenListIsDisplayed`.
   */
  homeWithTokenList: [
    '[data-testid="parent-selector-home"]',
    '[data-testid="multichain-token-list-button"]',
  ],
  /**
   * `AccountListPage.checkPageIsLoaded`, without its sync wait: that wait
   * holds the add-wallet button out of its syncing label for 2 s, a harness
   * stability window rather than an element.
   */
  accountList: [
    '[data-testid="parent-selector-account-list-page"]',
    '[data-testid="add-multichain-account-button"]',
    '[data-testid="multichain-account-list-search"]',
  ],
  /** `SendPage.checkNetworkFilterToggleIsDisplayed`. */
  sendNetworkFilter: ['[data-testid="send-network-filter-toggle"]'],
  /** `SendPage.checkSendFormIsLoaded`. */
  sendForm: [
    '[data-testid="send-amount-input"]',
    '[data-testid="recipient-address-input"]',
  ],
  /** `SnapTransactionConfirmation.checkPageIsLoaded`. */
  snapConfirmation: [
    '[data-testid="parent-selector-snap-confirmation-page"]',
    '[data-testid="confirm-sign-and-send-transaction-cancel-snap-footer-button"]',
    '[data-testid="confirm-sign-and-send-transaction-confirm-snap-footer-button"]',
  ],
  /** `SwapPage.checkPageIsLoaded`. */
  swapPage: [
    '[data-testid="from-amount"]',
    '[data-testid="bridge-destination-button"]',
    '[data-testid="parent-selector-bridge-quote"]',
  ],
  /** `SwapPage.checkQuoteIsDisplayed`. */
  swapQuote: [
    '[data-testid="network-fees"]',
    '[data-testid="slippage-edit-button"]',
    '[data-testid="minimum-received"]',
  ],
  /** The asset picker's search input, which `BridgeQuotePage` waits on. */
  bridgeAssetPicker: ['[data-testid="bridge-asset-picker-search-input"]'],
  /** `StartOnboardingPage.checkUserSrpButtonIsVisible`. */
  onboardingImportOptions: [
    '[data-testid="onboarding-import-with-srp-button"]',
  ],
  /** `StartOnboardingPage.checkSocialSignUpFormIsVisible`. */
  onboardingCreateOptions: [
    '[data-testid="onboarding-create-with-google-button"]',
  ],
  /** `OnboardingSrpPage.checkPageIsLoaded`, Continue disabled as it waits. */
  onboardingSrp: [
    '[data-testid="parent-selector-onboarding-srp"]',
    '[data-testid="srp-input-import__srp-note"]',
    '[data-testid="import-srp-confirm"]:disabled',
  ],
  /** `OnboardingPasswordPage.checkPageIsLoaded`. */
  onboardingPassword: [
    '[data-testid="parent-selector-onboarding-password"]',
    '[data-testid="create-password-new-input"]',
    '[data-testid="create-password-confirm-input"]',
  ],
  /** `SetupPasskeyPage.checkPageIsLoaded`. */
  setupPasskey: [
    '[data-testid="parent-selector-setup-passkey"]',
    '[data-testid="passkey-maybe-later-button"]',
    '[data-testid="passkey-set-up-button"]',
  ],
  /** `SecureWalletPage.checkPageIsLoaded`. */
  onboardingSecureWallet: [
    '[data-testid="parent-selector-secure-wallet"]',
    '[data-testid="recovery-phrase-remind-later"]',
  ],
  /** `OnboardingMetricsPage.checkPageIsLoaded`. */
  onboardingMetrics: [
    '[data-testid="parent-selector-onboarding-metrics"]',
    '[data-testid="metametrics-i-agree"]',
  ],
  /** `OnboardingCompletePage.checkPageIsLoaded`. */
  onboardingComplete: [
    '[data-testid="parent-selector-onboarding-complete"]',
    '[data-testid="manage-default-settings"]',
    '[data-testid="onboarding-complete-done"]',
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * `TokensTab.checkPriceChartIsShown` plus `checkPriceChartLoaded`, scoped to
 * the asset page: the token list on the home page carries the same
 * percentage test id, so unscoped it would match before the click.
 *
 * @param assetAddress - The address `checkPriceChartLoaded` is given.
 * @returns The selectors.
 */
export function assetPriceChartDestination(assetAddress: string): string[] {
  return [
    '[data-testid="asset-price-chart"]',
    `[data-testid="parent-selector-asset-details"] [data-testid="token-increase-decrease-percentage-${assetAddress}"]`,
  ];
}
