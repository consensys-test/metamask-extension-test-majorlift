import type { Driver } from '../../webdriver/driver';

/** How often the page is checked for the dialog while the destination loads. */
export const OPTIONAL_DIALOG_POLL_MS = 100;

/**
 * Overrides {@link OPTIONAL_DIALOG_POLL_MS}. Each check is a script that runs
 * in the page while a step's in-page timer is open, and what those checks
 * cost that timer is not measured; an A/A pair that differs only in this
 * value measures it. Unset or empty, the interval is
 * {@link OPTIONAL_DIALOG_POLL_MS}, as before.
 */
export const OPTIONAL_DIALOG_POLL_MS_ENV = 'BENCHMARK_OPTIONAL_DIALOG_POLL_MS';

/**
 * Read how often to check for the dialog.
 *
 * @returns The interval in milliseconds: the variable's value, or
 * `OPTIONAL_DIALOG_POLL_MS` when the variable is unset or empty.
 */
export function getOptionalDialogPollMs(): number {
  const raw = process.env[OPTIONAL_DIALOG_POLL_MS_ENV];
  if (raw === undefined || raw === '') {
    return OPTIONAL_DIALOG_POLL_MS;
  }
  const pollMs = Number(raw);
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error(
      `${OPTIONAL_DIALOG_POLL_MS_ENV} must be a positive integer, got "${raw}"`,
    );
  }
  return pollMs;
}

/**
 * Whether a selector matches in the page. Runs in the page; see
 * `installInPageStepProbe` for why it takes a one-element tuple.
 *
 * @param args - One-element tuple holding the selector.
 * @param args."0" - The CSS selector.
 * @returns Whether an element matches.
 */
export function isSelectorPresent([selector]: [string]): boolean {
  return document.querySelector(selector) !== null;
}

/**
 * Wait for a step's destination, dismissing an optional dialog if it appears
 * first.
 *
 * `destination` is the step's own wait, and it starts at once. While it runs,
 * the page is checked for `dialogSelector` every `pollMs`. If the destination
 * is reached first this returns when it is, so an iteration without the dialog
 * spends no fixed timeout ruling it out. If the dialog appears first,
 * `dismiss` runs and this then waits for the same `destination` call.
 *
 * @param driver - The WebDriver instance.
 * @param options - The step's wait and its optional dialog.
 * @param options.destination - The step's wait for its destination.
 * @param options.dialogSelector - CSS that matches only while the dialog shows.
 * @param options.dismiss - The harness action that dismisses the dialog.
 * @param options.pollMs - How often to check for the dialog; defaults to
 * {@link getOptionalDialogPollMs}.
 * @returns Whether the dialog appeared and was dismissed.
 */
export async function waitDismissingOptionalDialog(
  driver: Driver,
  {
    destination,
    dialogSelector,
    dismiss,
    pollMs = getOptionalDialogPollMs(),
  }: {
    destination: () => Promise<void>;
    dialogSelector: string;
    dismiss: () => Promise<void>;
    pollMs?: number;
  },
): Promise<boolean> {
  let settled = false;
  const reached = destination().finally(() => {
    settled = true;
  });
  // `settled` is set by `reached` while this loop awaits, so it is read
  // afresh on every pass.
  const dialogShown = (async (): Promise<boolean> => {
    for (;;) {
      if (settled) {
        return false;
      }
      if (
        (await driver.executeScript(isSelectorPresent, dialogSelector)) === true
      ) {
        return true;
      }
      await driver.delay(pollMs);
    }
  })();

  const dialogFirst = await Promise.race([
    reached.then(() => false),
    dialogShown,
  ]);
  if (dialogFirst) {
    await dismiss();
  }
  await reached;
  return dialogFirst;
}
