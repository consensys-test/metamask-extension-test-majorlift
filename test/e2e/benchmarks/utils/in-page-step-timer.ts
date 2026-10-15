import type { Driver } from '../../webdriver/driver';
import type { TimerResult } from './types';

/**
 * In-page step timing.
 *
 * The step timer in `measureStepWithLongTasks` reads the harness clock and,
 * in most journey steps, starts after the click that triggers the step has
 * already returned. This module times the same step a second time, inside the
 * page: from the trusted input event that triggers the step to the frame after
 * the destination's key element is in the DOM, both read with
 * `performance.now()`. The result is reported as `<stepId>InPage` beside the
 * existing timer, which is left exactly as it was, so one run carries both.
 *
 * An iteration reports nothing for the step, never zero, and logs why, when:
 * - no trusted input reached the trigger after the probe was installed;
 * - the destination was already in the DOM when the trigger fired, so the
 * selector does not distinguish this step's destination;
 * - a further trusted input arrived between the trigger and the destination,
 * so the region contains the harness's own reaction time;
 * - the destination never matched, or the probe was lost with its document.
 */

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
};

/**
 * One reading of a probe, as {@link readInPageStepProbe} returns it.
 */
export type InPageProbeReading = {
  /** `performance.now()` at the triggering input, or null if none arrived. */
  start: number | null;
  /** `performance.now()` one frame after the destination matched. */
  end: number | null;
  /** The event type that started the region. */
  startEvent: string | null;
  /** The destination already matched when the triggering input arrived. */
  preexisting: boolean;
  /** Trusted inputs after the trigger and before the destination matched. */
  extraInputs: number;
  /** The destination matched and its frame has not run yet. */
  pending: boolean;
  /** The probe was removed from the page by this read. */
  released: boolean;
};

type InPageProbe = {
  start: number | null;
  end: number | null;
  startEvent: string | null;
  preexisting: boolean;
  extraInputs: number;
  scheduled: boolean;
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
 * body.
 *
 * Capture-phase listeners on `document` record the first trusted pointerdown,
 * mousedown, click or keydown that qualifies as the trigger. A
 * MutationObserver then waits for every end selector to match and records the
 * time inside the next animation frame.
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
    scheduled: false,
    stop: () => undefined,
  };

  const check = (): void => {
    if (
      probe.start === null ||
      probe.scheduled ||
      probe.preexisting ||
      !matches()
    ) {
      return;
    }
    probe.scheduled = true;
    requestAnimationFrame(() => {
      probe.end = performance.now();
      probe.stop();
    });
  };

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
      }
      return;
    }
    // One gesture is one pointerdown or one keydown; the mousedown and click
    // that follow a pointerdown belong to it. Typing continues the trigger
    // when the trigger is typed. Anything after the destination matched
    // belongs to the next step.
    const anotherGesture =
      event.type === 'pointerdown' ||
      (event.type === 'keydown' && !config.typedOnly);
    if (anotherGesture && !probe.scheduled) {
      probe.extraInputs += 1;
    }
  };

  const observer = new MutationObserver(check);
  probe.stop = () => {
    observer.disconnect();
    for (const type of inputTypes) {
      document.removeEventListener(type, onInput, true);
    }
  };

  for (const type of inputTypes) {
    document.addEventListener(type, onInput, true);
  }
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
  });
  probes[config.stepId] = probe;
  return null;
}

/**
 * Read a step's probe. Runs in the page.
 *
 * The probe is removed unless its destination has matched and the frame that
 * records `end` has not run yet; `release` removes it regardless.
 *
 * @param args - Tuple of the step id and whether to remove the probe anyway.
 * @param args."0" - The step id the probe was installed under.
 * @param args."1" - Remove the probe even if its frame is still pending.
 * @returns The reading, or null when no probe exists in this document.
 */
export function readInPageStepProbe([stepId, release]: [
  string,
  boolean,
]): InPageProbeReading | null {
  const host = window as unknown as ProbeHost;
  const probe = host.__benchSteps?.[stepId];
  if (!probe) {
    return null;
  }
  const pending = probe.scheduled && probe.end === null;
  const released = release || !pending;
  if (released) {
    probe.stop();
    delete host.__benchSteps?.[stepId];
  }
  return {
    start: probe.start,
    end: probe.end,
    startEvent: probe.startEvent,
    preexisting: probe.preexisting,
    extraInputs: probe.extraInputs,
    pending,
    released,
  };
}

/**
 * Turn a reading into the `<stepId>InPage` timer, or into nothing with the
 * reason logged. Absent, never zero.
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
    return absent('the destination did not match after the trigger');
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
 * Read a step's probe and turn it into its timer. Call it once the step's
 * existing wait has returned. If the destination has matched and only its
 * frame is outstanding, this polls for up to `timeoutMs`; otherwise it reads
 * once. A failure is logged and never thrown.
 *
 * @param driver - The WebDriver instance.
 * @param stepId - The step id the probe was installed under.
 * @param options - Polling options.
 * @param options.timeoutMs - How long to wait for a pending frame.
 * @returns The `<stepId>InPage` timer, or an empty array.
 */
export async function finishInPageStep(
  driver: Driver,
  stepId: string,
  { timeoutMs = 2000 }: { timeoutMs?: number } = {},
): Promise<TimerResult[]> {
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const release = Date.now() >= deadline;
      const reading = (await driver.executeScript(
        readInPageStepProbe,
        stepId,
        release,
      )) as InPageProbeReading | null;
      if (reading === null || reading.released) {
        return inPageTimerResult(stepId, reading);
      }
      await driver.delay(25);
    }
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
