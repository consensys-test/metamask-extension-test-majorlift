/**
 * Read a flow's own iteration count from its module's `iterations` export: a
 * function returning the count for this run, the warm-up included, or
 * `undefined` for the invocation's.
 *
 * @param fileName - The flow's file name, for errors.
 * @param flowModule - The imported flow module's exports.
 * @returns The count `iterations()` returns, or `undefined` where the module
 * exports none or it returns `undefined`.
 */
function readOwnIterations(
  fileName: string,
  flowModule: Record<string, unknown>,
): number | undefined {
  const { iterations } = flowModule;
  if (iterations === undefined) {
    return undefined;
  }
  if (typeof iterations !== 'function') {
    throw new Error(
      `${fileName} exports \`iterations\` as a ${typeof iterations}; it must be a function returning a count or undefined`,
    );
  }
  const own: unknown = iterations();
  if (own !== undefined && typeof own !== 'number') {
    throw new Error(
      `${fileName}'s \`iterations()\` returned a ${typeof own}; it must return a count or undefined`,
    );
  }
  return own;
}

/**
 * The iterations a flow runs, logged as `run-benchmark.ts` logs them: the
 * flow module's own count where it exports `iterations()` and that returns
 * one, else the invocation's `--iterations`.
 *
 * @param fileName - The flow's file name, for the log.
 * @param flowModule - The imported flow module's exports.
 * @param options - The invocation's options.
 * @param options.iterations - The invocation's `--iterations`.
 * @param options.retries - The invocation's `--retries`, for the log.
 * @returns How many iterations to run, the warm-up included.
 */
export function resolveFlowIterations(
  fileName: string,
  flowModule: Record<string, unknown>,
  options: { iterations: number; retries: number },
): number {
  const iterations =
    readOwnIterations(fileName, flowModule) ?? options.iterations;

  console.log(
    `Running ${fileName} with ${iterations} iterations (retries: ${options.retries})`,
  );

  return iterations;
}
