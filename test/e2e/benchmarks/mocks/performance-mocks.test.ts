import type { Mockttp } from 'mockttp';
import { mockAuthAPICall, mockDelayMs } from './performance-mocks';

const SWITCH = 'BENCHMARK_ZERO_MOCK_DELAYS';

type Handler = (request: unknown) => Promise<unknown>;

/**
 * A mockttp server that records the handler `mockAuthAPICall` registers, so a
 * test can call it without a network.
 *
 * @returns The fake server and a getter for the registered handler.
 */
function fakeServer() {
  let handler: Handler | undefined;
  const builder = {
    asPriority: () => builder,
    always: () => builder,
    thenCallback: async (callback: Handler) => {
      handler = callback;
      return {};
    },
  };
  const server = { forGet: () => builder } as unknown as Mockttp;
  return {
    server,
    handler: () => {
      if (!handler) {
        throw new Error('no handler registered');
      }
      return handler;
    },
  };
}

const request = {
  path: '/api/v2/nonce',
  body: {
    getJson: async () => ({}),
    getText: async () => '',
  },
};

describe('performance-mocks delays', () => {
  afterEach(() => {
    delete process.env[SWITCH];
    jest.useRealTimers();
  });

  describe('mockDelayMs', () => {
    it('keeps the fixture delay when the switch is unset or 0', () => {
      expect(mockDelayMs(250)).toBe(250);
      process.env[SWITCH] = '0';
      expect(mockDelayMs(250)).toBe(250);
    });

    it('zeroes the delay when the switch is 1', () => {
      process.env[SWITCH] = '1';
      expect(mockDelayMs(250)).toBe(0);
    });
  });

  describe('mockAuthAPICall', () => {
    async function registered(delayMs: number) {
      const { server, handler } = fakeServer();
      await mockAuthAPICall(
        server,
        { url: /nonce/u, requestMethod: 'GET', response: () => ({ ok: true }) },
        delayMs,
      );
      return handler();
    }

    it('waits the fixture delay before responding when the switch is unset', async () => {
      jest.useFakeTimers();
      const handler = await registered(250);
      let response: unknown;

      const pending = handler(request).then((value) => {
        response = value;
      });
      await jest.advanceTimersByTimeAsync(249);
      expect(response).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await pending;

      expect(response).toStrictEqual({ statusCode: 200, json: { ok: true } });
    });

    it('responds without waiting when the switch is 1', async () => {
      jest.useFakeTimers();
      process.env[SWITCH] = '1';
      const handler = await registered(250);

      const response = await handler(request);

      expect(response).toStrictEqual({ statusCode: 200, json: { ok: true } });
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
