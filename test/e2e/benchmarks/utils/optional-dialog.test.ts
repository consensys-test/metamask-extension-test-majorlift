import type { Driver } from '../../webdriver/driver';
import {
  isSelectorPresent,
  waitDismissingOptionalDialog,
} from './optional-dialog';

const DIALOG = '[data-testid="dialog"]';

/**
 * A promise and the functions that settle it.
 *
 * @returns The deferred.
 */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A driver whose `executeScript` runs the page function against this test's
 * document, handing it the array of arguments as `Driver.executeScript` does,
 * and whose `delay` lets a test act between two checks for the dialog.
 *
 * @param betweenChecks - Called with the number of checks made so far, each
 * time the helper waits between two of them.
 * @returns The fake driver.
 */
function fakeDriver(betweenChecks: (checks: number) => void = () => undefined) {
  let checks = 0;
  const driver = {
    executeScript: jest.fn(
      async (script: (args: unknown[]) => unknown, ...args: unknown[]) => {
        checks += 1;
        return script(args);
      },
    ),
    delay: jest.fn(async () => {
      betweenChecks(checks);
      await new Promise((resolve) => setImmediate(resolve));
    }),
  };
  return driver as typeof driver & Driver;
}

function showDialog(): void {
  const dialog = document.createElement('div');
  dialog.setAttribute('data-testid', 'dialog');
  document.body.appendChild(dialog);
}

describe('optional-dialog', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('isSelectorPresent', () => {
    it('reports whether the selector matches in the document', () => {
      expect(isSelectorPresent([DIALOG])).toBe(false);
      showDialog();
      expect(isSelectorPresent([DIALOG])).toBe(true);
    });
  });

  describe('waitDismissingOptionalDialog', () => {
    it('returns when the destination is reached, without dismissing anything', async () => {
      const destination = deferred();
      const driver = fakeDriver((checks) => {
        if (checks === 2) {
          destination.resolve();
        }
      });
      const dismiss = jest.fn(async () => undefined);

      const dismissed = await waitDismissingOptionalDialog(driver, {
        destination: () => destination.promise,
        dialogSelector: DIALOG,
        dismiss,
      });

      expect(dismissed).toBe(false);
      expect(dismiss).not.toHaveBeenCalled();
      expect(driver.executeScript).toHaveBeenCalledWith(
        isSelectorPresent,
        DIALOG,
      );
    });

    it('stops checking for the dialog once the destination is reached', async () => {
      const destination = deferred();
      const driver = fakeDriver((checks) => {
        if (checks === 1) {
          destination.resolve();
        }
      });

      await waitDismissingOptionalDialog(driver, {
        destination: () => destination.promise,
        dialogSelector: DIALOG,
        dismiss: async () => undefined,
      });
      const checksAtReturn = driver.executeScript.mock.calls.length;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(driver.executeScript).toHaveBeenCalledTimes(checksAtReturn);
    });

    it('does not wait for a pending check once the destination is reached', async () => {
      const destination = deferred();
      const driver = {
        executeScript: jest.fn(() => new Promise<boolean>(() => undefined)),
        delay: jest.fn(async () => undefined),
      } as unknown as Driver;
      const waiting = waitDismissingOptionalDialog(driver, {
        destination: () => destination.promise,
        dialogSelector: DIALOG,
        dismiss: async () => undefined,
      });

      destination.resolve();

      expect(await waiting).toBe(false);
    });

    it('dismisses the dialog when it appears first, then waits for the destination', async () => {
      const order: string[] = [];
      const destination = deferred();
      const driver = fakeDriver((checks) => {
        if (checks === 2) {
          showDialog();
        }
      });

      const dismissed = await waitDismissingOptionalDialog(driver, {
        destination: async () => {
          await destination.promise;
          order.push('destination');
        },
        dialogSelector: DIALOG,
        dismiss: async () => {
          order.push('dismiss');
          destination.resolve();
        },
      });

      expect(dismissed).toBe(true);
      expect(order).toStrictEqual(['dismiss', 'destination']);
      expect(driver.executeScript).toHaveBeenCalledTimes(3);
    });

    it('propagates an error from the destination wait', async () => {
      const destination = deferred();
      const driver = fakeDriver((checks) => {
        if (checks === 1) {
          destination.reject(new Error('TimeoutError'));
        }
      });
      const dismiss = jest.fn(async () => undefined);

      await expect(
        waitDismissingOptionalDialog(driver, {
          destination: () => destination.promise,
          dialogSelector: DIALOG,
          dismiss,
        }),
      ).rejects.toThrow('TimeoutError');
      expect(dismiss).not.toHaveBeenCalled();
    });

    it('propagates an error from the destination wait after the dialog was dismissed', async () => {
      const destination = deferred();
      const driver = fakeDriver(() => showDialog());

      await expect(
        waitDismissingOptionalDialog(driver, {
          destination: () => destination.promise,
          dialogSelector: DIALOG,
          dismiss: async () => {
            destination.reject(new Error('TimeoutError'));
          },
        }),
      ).rejects.toThrow('TimeoutError');
    });
  });
});
