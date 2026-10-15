import type { Driver } from '../../webdriver/driver';
import {
  IN_PAGE_DESTINATIONS,
  assetPriceChartDestination,
  finishInPageStep,
  inPageTimerResult,
  installInPageStepProbe,
  measureStepInPage,
  readInPageStepProbe,
  type InPageProbeConfig,
} from './in-page-step-timer';

// eslint-disable-next-line @typescript-eslint/naming-convention
type ProbeHost = { __benchSteps?: Record<string, unknown> };
type InputInit = Partial<
  Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>
>;

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

let frames: FrameRequestCallback[];
let now: number;
let inputHandler: ((event: Event) => void) | undefined;

/**
 * Capture the probe's input listener as it is registered, so a test can hand
 * it the trusted events that only a real browser can produce.
 */
function captureInputHandler(): void {
  const addEventListener = jest.spyOn(document, 'addEventListener');
  addEventListener.mockImplementation(function (
    this: Document,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (type === 'pointerdown') {
      inputHandler = listener as (event: Event) => void;
    }
    EventTarget.prototype.addEventListener.call(this, type, listener, options);
  });
}

function trustedInput(
  type: string,
  target: Element,
  init: InputInit = {},
): void {
  if (!inputHandler) {
    throw new Error('No probe listener was captured');
  }
  inputHandler({ isTrusted: true, type, target, ...init } as unknown as Event);
}

function install(config: Partial<InPageProbeConfig> = {}): string | null {
  captureInputHandler();
  return installInPageStepProbe([
    {
      stepId: 'step',
      endSelectors: ['#destination'],
      startWithin: null,
      typedOnly: false,
      ...config,
    },
  ]);
}

async function addDestination(): Promise<void> {
  const destination = document.createElement('div');
  destination.id = 'destination';
  document.body.appendChild(destination);
  // MutationObserver callbacks run as microtasks after the mutation.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function runFrame(): void {
  const pending = frames;
  frames = [];
  for (const callback of pending) {
    callback(now);
  }
}

const element = (selector: string): Element => {
  const found = document.querySelector(selector);
  if (!found) {
    throw new Error(`No element matches ${selector}`);
  }
  return found;
};

describe('in-page-step-timer', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<button id="go"><span id="label">Go</span></button><input id="field" />';
    frames = [];
    now = 1000;
    inputHandler = undefined;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    };
  });

  afterEach(() => {
    const host = window as unknown as ProbeHost;
    for (const stepId of Object.keys(host.__benchSteps ?? {})) {
      readInPageStepProbe([stepId, true]);
    }
    delete host.__benchSteps;
    document.body.innerHTML = '';
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  });

  describe('installInPageStepProbe and readInPageStepProbe', () => {
    it('times from the triggering input to the frame after the destination appears', async () => {
      expect(install()).toBeNull();

      now = 1000;
      trustedInput('pointerdown', element('#go'));
      // The rest of the same click is not a second gesture.
      trustedInput('mousedown', element('#go'));
      trustedInput('click', element('#go'));
      now = 1100;
      await addDestination();

      expect(readInPageStepProbe(['step', false])).toStrictEqual({
        start: 1000,
        end: null,
        startEvent: 'pointerdown',
        preexisting: false,
        extraInputs: 0,
        pending: true,
        released: false,
      });

      now = 1116;
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toStrictEqual({
        start: 1000,
        end: 1116,
        startEvent: 'pointerdown',
        preexisting: false,
        extraInputs: 0,
        pending: false,
        released: true,
      });
      expect(inPageTimerResult('step', reading)).toStrictEqual([
        { id: 'stepInPage', value: 116, unit: 'ms' },
      ]);
      expect(readInPageStepProbe(['step', false])).toBeNull();
    });

    it('ignores input the browser did not mark as trusted', async () => {
      install();

      element('#go').dispatchEvent(new Event('pointerdown', { bubbles: true }));
      element('#go').dispatchEvent(new Event('click', { bubbles: true }));
      await addDestination();
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ start: null, end: null });
      expect(inPageTimerResult('step', reading)).toStrictEqual([]);
    });

    it('starts only on input inside `startWithin` when it is set', async () => {
      install({ startWithin: '#go' });

      now = 900;
      trustedInput('pointerdown', element('#field'));
      trustedInput('keydown', element('#field'), { key: 'p' });
      now = 1000;
      trustedInput('pointerdown', element('#label'));
      now = 1200;
      await addDestination();
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ start: 1000, end: 1200, extraInputs: 0 });
      expect(inPageTimerResult('step', reading)).toStrictEqual([
        { id: 'stepInPage', value: 200, unit: 'ms' },
      ]);
    });

    it('with `typedOnly`, skips the clear chord and starts on the first typed character', async () => {
      install({ startWithin: '#field', typedOnly: true });
      const field = element('#field');

      now = 500;
      trustedInput('keydown', field, { key: 'Control', ctrlKey: true });
      trustedInput('keydown', field, { key: 'a', ctrlKey: true });
      trustedInput('keydown', field, { key: 'Backspace', ctrlKey: true });
      trustedInput('keydown', field, { key: 'a', metaKey: true });
      trustedInput('pointerdown', field);
      now = 1000;
      trustedInput('keydown', field, { key: 'Shift', shiftKey: true });
      trustedInput('keydown', field, { key: 'F', shiftKey: true });
      now = 1005;
      trustedInput('keydown', field, { key: 'X', shiftKey: true });
      trustedInput('keydown', field, { key: 'S', shiftKey: true });
      now = 1300;
      await addDestination();
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({
        start: 1000,
        end: 1300,
        startEvent: 'keydown',
        extraInputs: 0,
      });
      expect(inPageTimerResult('step', reading)).toStrictEqual([
        { id: 'stepInPage', value: 300, unit: 'ms' },
      ]);
    });

    it('reports nothing when the destination is already present at the trigger', async () => {
      install();
      await addDestination();

      trustedInput('pointerdown', element('#go'));
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ preexisting: true, end: null });
      expect(inPageTimerResult('step', reading)).toStrictEqual([]);
    });

    it('reports nothing when another gesture arrives before the destination', async () => {
      install();

      trustedInput('pointerdown', element('#go'));
      trustedInput('pointerdown', element('#field'));
      trustedInput('keydown', element('#field'), { key: 'Enter' });
      await addDestination();
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ extraInputs: 2 });
      expect(reading?.end).not.toBeNull();
      expect(inPageTimerResult('step', reading)).toStrictEqual([]);
    });

    it('does not count input that arrives after the destination matched', async () => {
      install();

      now = 1000;
      trustedInput('pointerdown', element('#go'));
      now = 1050;
      await addDestination();
      trustedInput('pointerdown', element('#field'));
      now = 1060;
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ extraInputs: 0, end: 1060 });
      expect(inPageTimerResult('step', reading)).toStrictEqual([
        { id: 'stepInPage', value: 60, unit: 'ms' },
      ]);
    });

    it('waits for every end selector', async () => {
      install({ endSelectors: ['#destination', '#second'] });

      now = 1000;
      trustedInput('pointerdown', element('#go'));
      now = 1100;
      await addDestination();
      runFrame();
      expect(readInPageStepProbe(['step', false])).toMatchObject({
        start: 1000,
        end: null,
        pending: false,
      });
    });

    it('starts the frame once the last end selector matches', async () => {
      install({ endSelectors: ['#destination', '#second'] });

      now = 1000;
      trustedInput('pointerdown', element('#go'));
      await addDestination();
      now = 1400;
      const second = document.createElement('p');
      second.id = 'second';
      document.body.appendChild(second);
      await new Promise((resolve) => setTimeout(resolve, 0));
      now = 1410;
      runFrame();

      expect(
        inPageTimerResult('step', readInPageStepProbe(['step', false])),
      ).toStrictEqual([{ id: 'stepInPage', value: 410, unit: 'ms' }]);
    });

    it('reports nothing when the destination never matches', async () => {
      install({ endSelectors: ['#never'] });

      trustedInput('pointerdown', element('#go'));
      await addDestination();
      runFrame();
      const reading = readInPageStepProbe(['step', false]);

      expect(reading).toMatchObject({ end: null, pending: false });
      expect(inPageTimerResult('step', reading)).toStrictEqual([]);
    });

    it('keeps a probe whose frame is pending unless told to release it', async () => {
      install();

      trustedInput('pointerdown', element('#go'));
      await addDestination();

      expect(readInPageStepProbe(['step', false])).toMatchObject({
        pending: true,
        released: false,
      });
      expect(readInPageStepProbe(['step', true])).toMatchObject({
        pending: true,
        released: true,
        end: null,
      });
      expect(readInPageStepProbe(['step', false])).toBeNull();
    });

    it('rejects an invalid selector and installs nothing', () => {
      const failure = install({ endSelectors: ['[[['] });

      expect(failure).toMatch(/^invalid selector: /u);
      expect(readInPageStepProbe(['step', false])).toBeNull();
    });

    it('replaces a probe installed under the same step id', async () => {
      install();
      trustedInput('pointerdown', element('#go'));
      install();

      expect(readInPageStepProbe(['step', false])).toMatchObject({
        start: null,
      });
    });
  });

  describe('inPageTimerResult', () => {
    it('reports nothing when no probe was found', () => {
      expect(inPageTimerResult('step', null)).toStrictEqual([]);
    });
  });

  describe('measureStepInPage', () => {
    /**
     * A driver whose `executeScript` behaves as `Driver.executeScript` does:
     * the page function receives the array of arguments as its one argument.
     *
     * @param options - Fake driver behavior.
     * @param options.failFirst - Reject the first `executeScript` call.
     */
    function fakeDriver({ failFirst = false } = {}) {
      const order: string[] = [];
      let calls = 0;
      const driver = {
        executeScript: jest.fn(
          async (
            script: (args: unknown[]) => unknown,
            ...args: unknown[]
          ): Promise<unknown> => {
            calls += 1;
            order.push(`executeScript:${script.name}`);
            if (failFirst && calls === 1) {
              throw new Error('javascript error');
            }
            return script(args);
          },
        ),
        delay: jest.fn(async () => {
          order.push('delay');
          now += 16;
          runFrame();
        }),
      };
      return { driver: driver as unknown as Driver, order };
    }

    it('installs, runs the trigger and the timed wait in order, then reads', async () => {
      const { driver, order } = fakeDriver();
      captureInputHandler();

      const result = await measureStepInPage(driver, 'step', {
        endSelector: '#destination',
        trigger: async () => {
          order.push('trigger');
          now = 1000;
          trustedInput('pointerdown', element('#go'));
        },
        settle: async () => {
          order.push('settle');
          now = 1250;
          await addDestination();
        },
      });

      expect(order).toStrictEqual([
        'executeScript:installInPageStepProbe',
        'trigger',
        'settle',
        'executeScript:readInPageStepProbe',
        'delay',
        'executeScript:readInPageStepProbe',
      ]);
      expect(result).toStrictEqual([
        { id: 'stepInPage', value: 266, unit: 'ms' },
      ]);
    });

    it('still runs the trigger and the timed wait when the probe cannot be installed', async () => {
      const { driver, order } = fakeDriver({ failFirst: true });
      const trigger = jest.fn(async () => undefined);
      const settle = jest.fn(async () => undefined);

      const result = await measureStepInPage(driver, 'step', {
        endSelector: '#destination',
        trigger,
        settle,
      });

      expect(trigger).toHaveBeenCalledTimes(1);
      expect(settle).toHaveBeenCalledTimes(1);
      expect(order).toStrictEqual(['executeScript:installInPageStepProbe']);
      expect(result).toStrictEqual([]);
    });

    it('propagates an error from the timed wait, as the step always has', async () => {
      const { driver } = fakeDriver();

      await expect(
        measureStepInPage(driver, 'step', {
          endSelector: '#destination',
          trigger: async () => undefined,
          settle: async () => {
            throw new Error('TimeoutError');
          },
        }),
      ).rejects.toThrow('TimeoutError');
    });
  });

  describe('finishInPageStep', () => {
    it('releases a probe whose frame never runs once the timeout has passed', async () => {
      const driver = {
        executeScript: jest.fn(
          async (script: (args: unknown[]) => unknown, ...args: unknown[]) =>
            script(args),
        ),
        delay: jest.fn(async () => undefined),
      } as unknown as Driver;
      install();
      trustedInput('pointerdown', element('#go'));
      await addDestination();

      const result = await finishInPageStep(driver, 'step', { timeoutMs: 0 });

      expect(result).toStrictEqual([]);
      expect(readInPageStepProbe(['step', false])).toBeNull();
    });
  });

  describe('destinations', () => {
    it('are all valid CSS selectors', () => {
      const selectors = [
        ...Object.values(IN_PAGE_DESTINATIONS).flat(),
        ...assetPriceChartDestination(
          '0x0000000000000000000000000000000000000000',
        ),
        ...assetPriceChartDestination(
          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501',
        ),
      ];

      for (const selector of selectors) {
        expect(() => document.querySelector(selector)).not.toThrow();
      }
    });
  });
});
