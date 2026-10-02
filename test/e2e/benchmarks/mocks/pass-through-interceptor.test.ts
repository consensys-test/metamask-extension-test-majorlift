/**
 * Covers the pass-through interceptor call sites that the swap quote
 * delay depends on. A delaying interceptor only delays anything if the
 * caller awaits it, so this is the joint between
 * `swap-mocks.registerSwapInterceptor` and the handler that runs it.
 *
 * It lives under `benchmarks/` because jest's `testMatch` picks up
 * `test/e2e/benchmarks/**` but not `test/e2e/*.test.ts`, so a test
 * placed next to `mock-e2e-pass-through.ts` would never run.
 */

import type { Mockttp } from 'mockttp';
import {
  setPassThroughInterceptor,
  setupMockingPassThrough,
  type PassThroughInterceptor,
} from '../../mock-e2e-pass-through';
import { userStorageHostMock } from './performance-mocks';

type BeforeRequest = (req: {
  url: string;
  method: string;
}) => Promise<unknown> | unknown;

/**
 * A Mockttp stub that records the `beforeRequest` callback registered
 * by the catch-all `thenPassThrough` handler.
 *
 * @returns The stub server and a getter for the captured callback.
 */
function createPassThroughStub(): {
  server: Mockttp;
  getBeforeRequest: () => BeforeRequest;
} {
  let beforeRequest: BeforeRequest | undefined;

  const server = {
    forAnyRequest: () => ({
      asPriority: () => ({
        thenPassThrough: (options: { beforeRequest: BeforeRequest }) => {
          beforeRequest = options.beforeRequest;
          return Promise.resolve();
        },
      }),
    }),
    on: () => undefined,
  };

  return {
    server: server as unknown as Mockttp,
    getBeforeRequest: () => {
      if (!beforeRequest) {
        throw new Error('thenPassThrough was never called');
      }
      return beforeRequest;
    },
  };
}

/**
 * Register an interceptor and return the `beforeRequest` callback that
 * `setupMockingPassThrough` wired it into.
 *
 * @param interceptor - The interceptor to register.
 * @returns The registered `beforeRequest` callback.
 */
async function wire(
  interceptor: PassThroughInterceptor,
): Promise<BeforeRequest> {
  const { server, getBeforeRequest } = createPassThroughStub();
  await setupMockingPassThrough(server, async (innerServer) => {
    setPassThroughInterceptor(innerServer, interceptor);
    return [];
  });
  return getBeforeRequest();
}

describe('setupMockingPassThrough', () => {
  it('awaits an interceptor that returns a Promise', async () => {
    const beforeRequest = await wire(() =>
      Promise.resolve({ response: { statusCode: 418 } }),
    );

    const result = await beforeRequest({
      url: 'https://bridge.api.cx.metamask.io/getQuote',
      method: 'GET',
    });

    expect(result).toStrictEqual({ response: { statusCode: 418 } });
  });

  it('passes through when a Promise-returning interceptor resolves null', async () => {
    const beforeRequest = await wire(() => Promise.resolve(null));

    const result = await beforeRequest({
      url: 'https://example.com/',
      method: 'GET',
    });

    expect(result).toStrictEqual({});
  });

  it('still handles a synchronous interceptor that returns a response', async () => {
    const beforeRequest = await wire(() => ({
      response: { statusCode: 200, json: [] },
    }));

    const result = await beforeRequest({
      url: 'https://example.com/',
      method: 'GET',
    });

    expect(result).toStrictEqual({ response: { statusCode: 200, json: [] } });
  });

  it('still passes through a synchronous interceptor that returns null', async () => {
    const beforeRequest = await wire(() => null);

    const result = await beforeRequest({
      url: 'https://example.com/',
      method: 'GET',
    });

    expect(result).toStrictEqual({});
  });

  it('passes through when no interceptor is registered', async () => {
    const { server, getBeforeRequest } = createPassThroughStub();
    await setupMockingPassThrough(server);

    const result = await getBeforeRequest()({
      url: 'https://example.com/',
      method: 'GET',
    });

    expect(result).toStrictEqual({});
  });
});

describe('userStorageHostMock interceptor chaining', () => {
  /**
   * A Mockttp stub covering just the rule-builder calls
   * `userStorageHostMock` makes.
   *
   * @returns A stub server.
   */
  function createRuleStub(): Mockttp {
    const server = {
      forGet: () => ({
        forHost: () => ({
          always: () => ({
            thenCallback: () => Promise.resolve({}),
          }),
        }),
      }),
    };
    return server as unknown as Mockttp;
  }

  it('propagates a Promise returned by the interceptor it wraps', async () => {
    const server = createRuleStub();
    setPassThroughInterceptor(server, () =>
      Promise.resolve({ response: { statusCode: 418 } }),
    );

    await userStorageHostMock(server);

    const chained = (server as unknown as Record<string, unknown>)
      .__passThroughInterceptor as PassThroughInterceptor;
    const result = chained({
      url: 'https://bridge.api.cx.metamask.io/getQuote',
      method: 'GET',
    });

    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toStrictEqual({
      response: { statusCode: 418 },
    });
  });

  it('still answers its own host synchronously', async () => {
    const server = createRuleStub();
    setPassThroughInterceptor(server, () =>
      Promise.resolve({ response: { statusCode: 418 } }),
    );

    await userStorageHostMock(server);

    const chained = (server as unknown as Record<string, unknown>)
      .__passThroughInterceptor as PassThroughInterceptor;
    const result = chained({
      url: 'https://user-storage.api.cx.metamask.io/v1/userstorage',
      method: 'GET',
    });

    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toStrictEqual({
      response: { statusCode: 200, json: null },
    });
  });
});
