import type { Mockttp } from 'mockttp';
import type { Driver } from '../../webdriver/driver';
import { FailIterationError } from './in-page-step-timer';
import {
  TriggerQuietError,
  executeAsyncInPage,
  movePointerOnto,
  trackMockTraffic,
  waitForBackgroundIdleInPage,
  waitForPageQuietInPage,
  waitForTriggerQuiet,
  type BackgroundIdleReading,
  type MockTraffic,
  type PageQuietReading,
} from './trigger-quiet';

/**
 * A page clock the test moves by hand: timers and idle callbacks run only
 * when the test says, so a test can make time pass with no timer running, as
 * a busy main thread does.
 */
function fakePage() {
  let now = 0;
  let nextId = 1;
  let timers: { id: number; at: number; run: () => void }[] = [];
  const idle: ((deadline: { timeRemaining: () => number }) => void)[] = [];
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
    run: () => void,
    delay = 0,
  ) => {
    const id = nextId;
    nextId += 1;
    timers.push({ id, at: now + delay, run });
    return id;
  }) as unknown as typeof setTimeout);
  jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    timers = timers.filter((timer) => timer.id !== id);
  }) as unknown as typeof clearTimeout);
  const host = globalThis as unknown as {
    requestIdleCallback?: (
      callback: (deadline: { timeRemaining: () => number }) => void,
    ) => number;
  };
  const originalIdle = host.requestIdleCallback;
  host.requestIdleCallback = (callback) => {
    idle.push(callback);
    return idle.length;
  };
  return {
    get now() {
      return now;
    },
    /**
     * Run every timer due within `ms`, in order, moving the clock to each.
     *
     * @param ms - How far to move the clock.
     */
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers
          .filter((timer) => timer.at <= until)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) {
          break;
        }
        timers = timers.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        due.run();
      }
      now = until;
    },
    /**
     * Let time pass with no timer running, as when the main thread is busy.
     *
     * @param ms - How long the thread is held.
     */
    hold(ms: number) {
      now += ms;
    },
    /** How many idle callbacks are waiting for an idle period. */
    get idleWaiting() {
      return idle.length;
    },
    /**
     * Run the callbacks queued for the current idle period.
     *
     * @param remaining - What `timeRemaining()` returns.
     */
    idlePeriod(remaining = 49.5) {
      idle
        .splice(0)
        .forEach((callback) => callback({ timeRemaining: () => remaining }));
    },
    restore() {
      host.requestIdleCallback = originalIdle;
    },
  };
}

describe('trackMockTraffic', () => {
  function fakeMockServer() {
    const listeners: Record<string, (event: { id: string }) => void> = {};
    const mockServer = {
      on: jest.fn(
        async (event: string, callback: (event: { id: string }) => void) => {
          listeners[event] = callback;
        },
      ),
    };
    return {
      mockServer: mockServer as unknown as Pick<Mockttp, 'on'>,
      emit: (event: string, id: string) => listeners[event]({ id }),
    };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: 10_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('listens for requests, answers and aborts on the mock server', async () => {
    const { mockServer } = fakeMockServer();

    await trackMockTraffic(mockServer);

    expect(
      jest.mocked(mockServer.on).mock.calls.map(([event]) => event),
    ).toStrictEqual(['request', 'response', 'abort']);
  });

  it('counts received, answered and aborted, and what is still awaiting an answer', async () => {
    const { mockServer, emit } = fakeMockServer();
    const traffic = await trackMockTraffic(mockServer);
    expect(traffic.lastReceivedAt).toBe(10_000);

    jest.setSystemTime(10_100);
    emit('request', 'a');
    jest.setSystemTime(10_200);
    emit('request', 'b');
    emit('request', 'c');
    emit('response', 'a');
    emit('abort', 'b');
    // An answer to a request received before tracking began is not counted.
    emit('response', 'before');

    expect(traffic).toMatchObject({
      received: 3,
      answered: 1,
      aborted: 1,
      lastReceivedAt: 10_200,
    });
    expect([...traffic.awaiting]).toStrictEqual(['c']);
  });
});

describe('waitForPageQuietInPage', () => {
  let page: ReturnType<typeof fakePage>;
  beforeEach(() => {
    page = fakePage();
  });
  afterEach(() => {
    page.restore();
  });

  it('without a heartbeat, ends on the last of the idle periods asked for, not before', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [{ idlePeriods: 3, heartbeat: null, capMs: 5_000, tickMs: 2 }],
      done,
    );
    page.advance(10);
    page.idlePeriod();
    page.idlePeriod();
    expect(done).not.toHaveBeenCalled();
    page.advance(5);
    page.idlePeriod(12.25);

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({
      outcome: 'quiet',
      waitedMs: 15,
      heartbeatHeldAtMs: null,
      largestGapMs: null,
      idlePeriods: 3,
      lastIdleRemainingMs: 12.25,
    });
  });

  it('with a heartbeat, asks for no idle period until the timer has run on time for the window', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [
        {
          idlePeriods: 2,
          heartbeat: { windowMs: 250, stallMs: 8 },
          capMs: 5_000,
          tickMs: 2,
        },
      ],
      done,
    );
    page.advance(248);
    expect(page.idleWaiting).toBe(0);
    page.advance(2);
    expect(page.idleWaiting).toBe(1);
    page.idlePeriod();
    page.idlePeriod();

    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'quiet',
        heartbeatHeldAtMs: 250,
        largestGapMs: 2,
        idlePeriods: 2,
      }),
    );
  });

  it('restarts the heartbeat window after a gap over the stall threshold', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [
        {
          idlePeriods: 2,
          heartbeat: { windowMs: 250, stallMs: 8 },
          capMs: 5_000,
          tickMs: 2,
        },
      ],
      done,
    );
    page.advance(200);
    // A 40 ms task: the next timer runs 40 ms late.
    page.hold(40);
    page.advance(249);
    expect(page.idleWaiting).toBe(0);
    page.advance(10);
    page.idlePeriod();
    page.idlePeriod();

    const reading = done.mock.calls[0][0] as PageQuietReading;
    expect(reading.outcome).toBe('quiet');
    expect(reading.largestGapMs).toBe(40);
    // On time again from 240, so the window holds at 490.
    expect(reading.heartbeatHeldAtMs).toBe(490);
  });

  it('a gap at the threshold is not a stall', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [
        {
          idlePeriods: 1,
          heartbeat: { windowMs: 250, stallMs: 8 },
          capMs: 5_000,
          tickMs: 2,
        },
      ],
      done,
    );
    page.advance(100);
    // The timer due at 102 runs at 108: a gap of exactly 8 ms.
    page.hold(8);
    page.advance(150);
    page.idlePeriod();

    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'quiet',
      largestGapMs: 8,
      heartbeatHeldAtMs: 250,
    });
  });

  it('reports capped when the page never goes idle within the cap, and ignores a late idle period', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [{ idlePeriods: 2, heartbeat: null, capMs: 5_000, tickMs: 2 }],
      done,
    );
    page.advance(4_999);
    expect(done).not.toHaveBeenCalled();
    page.advance(1);
    page.idlePeriod();
    page.idlePeriod();

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'capped',
        waitedMs: 5_000,
        idlePeriods: 0,
      }),
    );
  });

  it('reports capped when the heartbeat never runs on time within the cap', () => {
    const done = jest.fn();

    waitForPageQuietInPage(
      [
        {
          idlePeriods: 2,
          heartbeat: { windowMs: 250, stallMs: 8 },
          capMs: 1_000,
          tickMs: 2,
        },
      ],
      done,
    );
    for (let elapsed = 0; elapsed < 1_000; elapsed += 200) {
      page.advance(190);
      page.hold(10);
    }
    page.advance(1);

    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'capped',
      heartbeatHeldAtMs: null,
      idlePeriods: 0,
    });
  });
});

describe('waitForBackgroundIdleInPage', () => {
  type Runtime = {
    sendMessage?: (message: unknown, callback: () => void) => void;
    lastError?: { message?: string };
  };
  const host = window as unknown as { chrome?: { runtime?: Runtime } };
  let page: ReturnType<typeof fakePage>;
  const part = {
    windowMs: 250,
    answerMs: 5,
    capMs: 5_000,
    pauseMs: 2,
    checkMs: 10,
    message: { type: 'BENCHMARK_TRIGGER_QUIET_PING' },
    portClosed: 'message port closed',
  };

  /**
   * A runtime that answers each message after `answerMs(n)` ms, the n-th
   * message counted from 0, with `lastError` set as given.
   *
   * @param answerMs - How long the n-th answer takes.
   * @param lastError - The error the browser reports with each answer.
   * @param lastError.message - Its message.
   */
  function fakeRuntime(
    answerMs: (n: number) => number,
    lastError?: { message: string },
  ) {
    const sent: unknown[] = [];
    const runtime: Runtime = {
      sendMessage(message, callback) {
        const n = sent.length;
        sent.push(message);
        setTimeout(() => {
          runtime.lastError = lastError;
          callback();
          delete runtime.lastError;
        }, answerMs(n));
      },
    };
    host.chrome = { runtime };
    return sent;
  }

  beforeEach(() => {
    page = fakePage();
  });
  afterEach(() => {
    page.restore();
    delete host.chrome;
  });

  it('ends once every answer has come within the threshold for the window', () => {
    const done = jest.fn();
    // The browser's report when no listener answers a message.
    const sent = fakeRuntime(() => 1, {
      message: 'The message port closed before a response was received.',
    });

    waitForBackgroundIdleInPage([part], done);
    page.advance(249);
    expect(done).not.toHaveBeenCalled();
    page.advance(11);

    const reading = done.mock.calls[0][0] as BackgroundIdleReading;
    expect(reading).toMatchObject({
      outcome: 'idle',
      lastAnswerMs: 1,
      reason: null,
    });
    expect(reading.promptForMs).toBeGreaterThanOrEqual(250);
    expect(reading.answered).toBeGreaterThan(50);
    expect(reading.portClosed).toBe(reading.answered);
    expect(sent[0]).toStrictEqual({ type: 'BENCHMARK_TRIGGER_QUIET_PING' });
    // One message in flight: no more were sent than were answered, plus one.
    expect(sent.length).toBeLessThanOrEqual(reading.answered + 1);
  });

  it('restarts the window after a slow answer', () => {
    const done = jest.fn();
    let slowSent = false;
    fakeRuntime(() => {
      if (page.now >= 100 && !slowSent) {
        slowSent = true;
        return 20;
      }
      return 1;
    });

    waitForBackgroundIdleInPage([part], done);
    page.advance(300);
    expect(done).not.toHaveBeenCalled();
    page.advance(100);

    const reading = done.mock.calls[0][0] as BackgroundIdleReading;
    expect(reading.outcome).toBe('idle');
    // A listener answered every one, so no port closed unanswered.
    expect(reading.portClosed).toBe(0);
    // The slow message, sent at 102, was answered at 122; the window
    // restarted with the next message, sent at 124.
    expect(reading.waitedMs).toBeGreaterThanOrEqual(370);
  });

  it('does not end while the message in flight has been out longer than the threshold', () => {
    const done = jest.fn();
    fakeRuntime((n) => (n === 0 ? 1 : 1_000));

    waitForBackgroundIdleInPage([part], done);
    page.advance(260);

    expect(done).not.toHaveBeenCalled();
  });

  it('reports capped when answers stay slow until the cap', () => {
    const done = jest.fn();
    fakeRuntime(() => 6);

    waitForBackgroundIdleInPage([part], done);
    page.advance(5_010);

    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'capped',
      lastAnswerMs: 6,
      promptForMs: null,
    });
  });

  it('reports unreadable when the message is rejected for any reason but an unanswered port, so it never passes on the browser alone', () => {
    const done = jest.fn();
    fakeRuntime(() => 0.5, {
      message: 'Could not establish connection. Receiving end does not exist.',
    });

    waitForBackgroundIdleInPage([part], done);
    page.advance(300);

    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'unreadable',
      answered: 0,
      reason:
        'the message was rejected: Could not establish connection. Receiving end does not exist.',
    });
  });

  it('reports unreadable when sendMessage throws', () => {
    const done = jest.fn();
    host.chrome = {
      runtime: {
        sendMessage: () => {
          throw new Error('Extension context invalidated.');
        },
      },
    };

    waitForBackgroundIdleInPage([part], done);

    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'unreadable',
      reason: 'sendMessage threw: Error: Extension context invalidated.',
    });
  });

  it('reports unreadable when the page has no runtime to send through', () => {
    const done = jest.fn();

    waitForBackgroundIdleInPage([part], done);

    expect(done.mock.calls[0][0]).toMatchObject({
      outcome: 'unreadable',
      reason: 'chrome.runtime.sendMessage is not available here',
    });
  });
});

describe('executeAsyncInPage', () => {
  it('passes a function as it is when tsx has not named anything in it', async () => {
    const executeAsyncScript = jest.fn().mockResolvedValue('result');
    const script = (_args: unknown, done: (value: string) => void) => done('x');

    const result = await executeAsyncInPage(
      { executeAsyncScript } as unknown as Driver,
      script,
      { a: 1 },
    );

    expect(result).toBe('result');
    expect(executeAsyncScript).toHaveBeenCalledWith(script, { a: 1 });
  });

  it('defines `__name` in the page for a function tsx named things in, as Driver.executeScript does', async () => {
    const executeAsyncScript = jest.fn().mockResolvedValue(null);
    // The shape tsx gives a function whose inner functions it names.
    const script = {
      toString: () =>
        'function (args, done) { const f = __name(() => done(1), "f"); f(); }',
    } as unknown as (...args: never[]) => void;

    await executeAsyncInPage(
      { executeAsyncScript } as unknown as Driver,
      script,
      7,
    );

    expect(executeAsyncScript).toHaveBeenCalledWith(
      'var __name = (fn) => fn; return (function (args, done) { const f = __name(() => done(1), "f"); f(); }).apply(null, arguments);',
      7,
    );
  });
});

describe('waitForTriggerQuiet', () => {
  const pageQuiet: PageQuietReading = {
    outcome: 'quiet',
    waitedMs: 312.4,
    heartbeatHeldAtMs: 260.25,
    largestGapMs: 61.2,
    idlePeriods: 2,
    lastIdleRemainingMs: 49.9,
  };
  const backgroundIdle: BackgroundIdleReading = {
    outcome: 'idle',
    waitedMs: 254.6,
    answered: 87,
    portClosed: 87,
    lastAnswerMs: 1.25,
    promptForMs: 251.5,
    reason: null,
  };

  function traffic(overrides: Partial<MockTraffic> = {}): MockTraffic {
    return {
      received: 0,
      answered: 0,
      aborted: 0,
      lastReceivedAt: Date.now(),
      awaiting: new Set(),
      ...overrides,
    };
  }

  /**
   * A driver whose page scripts return the given readings, by script, and
   * record the order and the configuration they ran with.
   *
   * @param readings - What each page part reports.
   * @param readings.page - The page part's reading, or an error to throw.
   * @param readings.background - The background part's reading.
   */
  function fakeDriver(readings: {
    page?: PageQuietReading | Error;
    background?: BackgroundIdleReading;
  }) {
    const order: string[] = [];
    const configs: Record<string, unknown> = {};
    const executeAsyncScript = jest.fn(
      async (script: unknown, config: unknown) => {
        if (script === waitForPageQuietInPage) {
          order.push('page');
          configs.page = config;
          if (readings.page instanceof Error) {
            throw readings.page;
          }
          return readings.page;
        }
        if (script === waitForBackgroundIdleInPage) {
          order.push('background');
          configs.background = config;
          return readings.background;
        }
        throw new Error('unexpected script');
      },
    );
    return {
      driver: { executeAsyncScript } as unknown as Driver,
      order,
      configs,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: 50_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs no part, and touches nothing, when given none', async () => {
    const { driver, order } = fakeDriver({});

    await expect(
      waitForTriggerQuiet(driver, 'step', {}),
    ).resolves.toStrictEqual([]);
    expect(order).toStrictEqual([]);
  });

  it('runs the parts given in the order background, mock, page, and returns one reading each', async () => {
    const { driver, order, configs } = fakeDriver({
      page: pageQuiet,
      background: backgroundIdle,
    });
    const mockTraffic = traffic({ lastReceivedAt: Date.now() - 600 });

    const readings = await waitForTriggerQuiet(driver, 'step', {
      page: {
        idlePeriods: 2,
        heartbeat: { windowMs: 250, stallMs: 8 },
        capMs: 5_000,
      },
      mock: { traffic: mockTraffic, quietMs: 500, capMs: 10_000 },
      background: { windowMs: 250, answerMs: 5, capMs: 5_000 },
    });

    expect(order).toStrictEqual(['background', 'page']);
    expect(readings).toStrictEqual([
      'trigger-quiet background idle after 254.6 ms: 87 message(s) answered, 87 of them by the port closing unanswered, the last in 1.3 ms, every one within 5 ms for 251.5 ms (250 ms asked)',
      'trigger-quiet mock quiet after 0 ms: 600 ms since the last request (500 ms asked), 0 awaiting an answer, and during the wait 0 received, 0 answered, 0 aborted',
      'trigger-quiet page idle after 312.4 ms: heartbeat ran 250 ms without a gap over 8 ms by +260.3 ms (largest gap 61.2 ms), then 2 of 2 idle period(s), the last with 49.9 ms remaining',
    ]);
    // The readings line joins its parts with "; ", so no part may contain it.
    expect(readings.filter((part) => part.includes('; '))).toStrictEqual([]);
    // Each part's thresholds reach the page as the call site set them.
    expect(configs.page).toStrictEqual({
      idlePeriods: 2,
      heartbeat: { windowMs: 250, stallMs: 8 },
      capMs: 5_000,
      tickMs: 2,
    });
    expect(configs.background).toMatchObject({
      windowMs: 250,
      answerMs: 5,
      capMs: 5_000,
      message: { type: 'BENCHMARK_TRIGGER_QUIET_PING' },
    });
  });

  it('describes a page part without a heartbeat by its idle periods alone', async () => {
    const { driver } = fakeDriver({
      page: { ...pageQuiet, heartbeatHeldAtMs: null, largestGapMs: null },
    });

    await expect(
      waitForTriggerQuiet(driver, 'step', {
        page: { idlePeriods: 2, heartbeat: null, capMs: 5_000 },
      }),
    ).resolves.toStrictEqual([
      'trigger-quiet page idle after 312.4 ms: 2 of 2 idle period(s), the last with 49.9 ms remaining',
    ]);
  });

  describe('the mock part', () => {
    it('waits until nothing has been received for Q and nothing awaits an answer, and counts the traffic during the wait', async () => {
      const mockTraffic = traffic({ received: 5, answered: 4 });
      mockTraffic.awaiting.add('poll');
      const { driver } = fakeDriver({});

      let readings: string[] | undefined;
      const waiting = waitForTriggerQuiet(driver, 'step', {
        mock: { traffic: mockTraffic, quietMs: 500, capMs: 10_000 },
      }).then((result) => {
        readings = result;
      });

      // Quiet long enough, but the poll is still awaiting its answer.
      await jest.advanceTimersByTimeAsync(600);
      expect(readings).toBeUndefined();
      mockTraffic.awaiting.delete('poll');
      mockTraffic.answered += 1;
      // A new request restarts the quiet.
      mockTraffic.received += 1;
      mockTraffic.lastReceivedAt = Date.now();
      mockTraffic.awaiting.add('icon');
      await jest.advanceTimersByTimeAsync(100);
      mockTraffic.awaiting.delete('icon');
      mockTraffic.aborted += 1;
      await jest.advanceTimersByTimeAsync(380);
      expect(readings).toBeUndefined();
      await jest.advanceTimersByTimeAsync(40);
      await waiting;

      expect(readings).toStrictEqual([
        'trigger-quiet mock quiet after 1100 ms: 500 ms since the last request (500 ms asked), 0 awaiting an answer, and during the wait 1 received, 1 answered, 1 aborted',
      ]);
    });

    it('fails at its cap, logging which part and why', async () => {
      const log = jest
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);
      const mockTraffic = traffic();
      mockTraffic.awaiting.add('hung');
      const { driver } = fakeDriver({});

      const waiting = waitForTriggerQuiet(driver, 'reviewStep', {
        mock: { traffic: mockTraffic, quietMs: 500, capMs: 10_000 },
      });
      const failed = expect(waiting).rejects.toThrow(
        'trigger-quiet mock capped at 10000 ms (cap 10000 ms): 10000 ms since the last request (500 ms asked), 1 awaiting an answer, and during the wait 0 received, 0 answered, 0 aborted',
      );
      await jest.advanceTimersByTimeAsync(10_000);
      await failed;
      await expect(waiting).rejects.toBeInstanceOf(TriggerQuietError);
      await expect(waiting).rejects.toBeInstanceOf(FailIterationError);
      expect(log).toHaveBeenCalledWith(
        '[benchmark] reviewStep trigger-quiet failed: mock capped at 10000 ms (cap 10000 ms): 10000 ms since the last request (500 ms asked), 1 awaiting an answer, and during the wait 0 received, 0 answered, 0 aborted',
      );
    });
  });

  it('fails when the page part reaches its cap, and runs nothing after it', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = fakeDriver({
      page: {
        ...pageQuiet,
        outcome: 'capped',
        waitedMs: 5_000,
        heartbeatHeldAtMs: null,
        largestGapMs: 131,
        idlePeriods: 0,
        lastIdleRemainingMs: null,
      },
    });

    await expect(
      waitForTriggerQuiet(driver, 'step', {
        page: {
          idlePeriods: 2,
          heartbeat: { windowMs: 250, stallMs: 8 },
          capMs: 5_000,
        },
      }),
    ).rejects.toThrow(
      new TriggerQuietError(
        'trigger-quiet page capped at 5000.0 ms (cap 5000 ms): heartbeat never ran 250 ms without a gap over 8 ms (largest gap 131.0 ms), then 0 of 2 idle period(s), the last with none remaining',
      ),
    );
  });

  it('fails when the background part reaches its cap, before the mock and page parts run', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver, order } = fakeDriver({
      page: pageQuiet,
      background: {
        ...backgroundIdle,
        outcome: 'capped',
        waitedMs: 5_000,
        lastAnswerMs: 9,
        promptForMs: null,
      },
    });

    await expect(
      waitForTriggerQuiet(driver, 'step', {
        background: { windowMs: 250, answerMs: 5, capMs: 5_000 },
        mock: { traffic: traffic(), quietMs: 500, capMs: 10_000 },
        page: { idlePeriods: 2, heartbeat: null, capMs: 5_000 },
      }),
    ).rejects.toThrow(
      'trigger-quiet background capped at 5000.0 ms (cap 5000 ms): 87 message(s) answered, 87 of them by the port closing unanswered, the last in 9.0 ms, every one within 5 ms for none (250 ms asked)',
    );
    expect(order).toStrictEqual(['background']);
  });

  it('fails as unreadable when a background message is rejected', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = fakeDriver({
      background: {
        outcome: 'unreadable',
        waitedMs: 0.5,
        answered: 0,
        portClosed: 0,
        lastAnswerMs: null,
        promptForMs: null,
        reason: 'the message was rejected: Receiving end does not exist.',
      },
    });

    await expect(
      waitForTriggerQuiet(driver, 'step', {
        background: { windowMs: 250, answerMs: 5, capMs: 5_000 },
      }),
    ).rejects.toThrow(
      'trigger-quiet background unreadable after 0.5 ms: the message was rejected: Receiving end does not exist.; 0 message(s) answered, 0 of them by the port closing unanswered, the last in none, every one within 5 ms for none (250 ms asked)',
    );
  });

  it('fails, rather than pass, when a page part cannot run', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const { driver } = fakeDriver({ page: new Error('script timeout') });

    await expect(
      waitForTriggerQuiet(driver, 'step', {
        page: { idlePeriods: 2, heartbeat: null, capMs: 5_000 },
      }),
    ).rejects.toThrow(
      new TriggerQuietError('trigger-quiet page unreadable: script timeout'),
    );
  });
});

describe('movePointerOnto', () => {
  it('finds the element, moves the pointer onto its center, then holds it there', async () => {
    const order: string[] = [];
    const element = { id: 'unlock' };
    const move = jest.fn((_options: unknown) => ({
      perform: async () => {
        order.push('perform');
      },
    }));
    const actions = jest.fn((_options: unknown) => ({ move }));
    const driver = {
      findElement: jest.fn(async (selector: string) => {
        order.push(`find ${selector}`);
        return element;
      }),
      driver: { actions },
      delay: jest.fn(async (ms: number) => {
        order.push(`delay ${ms}`);
      }),
    } as unknown as Driver;

    const reading = await movePointerOnto(
      driver,
      '[data-testid="unlock-submit"]',
      300,
    );

    expect(order).toStrictEqual([
      'find [data-testid="unlock-submit"]',
      'perform',
      'delay 300',
    ]);
    expect(actions).toHaveBeenCalledWith({ async: true });
    expect(move).toHaveBeenCalledWith({ origin: element });
    expect(reading).toMatch(
      /^pointer moved onto \[data-testid="unlock-submit"\] in \d+ ms, then held \d+ ms$/u,
    );
  });
});
