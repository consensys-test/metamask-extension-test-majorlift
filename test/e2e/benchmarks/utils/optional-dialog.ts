import type { Driver } from '../../webdriver/driver';

/** How often the page is checked for the dialog while the destination loads. */
export const OPTIONAL_DIALOG_POLL_MS = 100;

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
 * @param options.pollMs - How often to check for the dialog.
 * @returns Whether the dialog appeared and was dismissed.
 */
export async function waitDismissingOptionalDialog(
  driver: Driver,
  {
    destination,
    dialogSelector,
    dismiss,
    pollMs = OPTIONAL_DIALOG_POLL_MS,
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
