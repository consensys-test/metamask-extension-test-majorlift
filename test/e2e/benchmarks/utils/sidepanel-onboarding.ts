import { getCleanAppState } from '../../helpers';
import type { Driver } from '../../webdriver/driver';

/**
 * After the onboarding Done click, load the home page into the test window
 * where the build opens it in the side panel instead. This is the navigation
 * in `handleSidepanelPostOnboarding` (`page-objects/flows/onboarding.flow.ts`)
 * without its closing wait for the header, so a step timer opened when this
 * returns covers the header and the rest of the home page.
 *
 * It waits for `completedOnboarding`, then navigates to `home.html`. The
 * navigation returns once the document has loaded, so the load itself stays
 * before the step.
 *
 * @param driver - The WebDriver instance.
 * @returns Whether it loaded the home page; only Chrome has the side panel.
 */
export async function loadHomeAfterSidepanelOnboarding(
  driver: Driver,
): Promise<boolean> {
  // The same condition `handleSidepanelPostOnboarding` uses.
  if (process.env.SELENIUM_BROWSER !== 'chrome') {
    return false;
  }

  await driver.waitUntil(
    async () => {
      const uiState = await getCleanAppState(driver);
      return Boolean(uiState?.metamask?.completedOnboarding);
    },
    { timeout: 30000, interval: 500 },
  );
  await driver.driver.get(`${driver.extensionUrl}/home.html`);
  return true;
}
