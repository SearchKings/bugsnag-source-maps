/**
 * Run a series of async operations in parallel, with a configurable concurrency factor
 * @param queue Array of operations to run in parallel
 * @param concurrency How many operations can be run at the same time
 * @returns An array of 'results' as defined be the `queue` return value
 */
export const promiseAllN = async <T>(
  queue: Promise<T>[] | (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> => {
  let index = 0;
  const results: any[] = [];

  // Run a pseudo-thread
  const execThread = async () => {
    while (index < queue.length) {
      const curIndex = index++;
      // Use of `curIndex` is important because `index` may change after await is resolved
      results[curIndex] =
        typeof queue[curIndex] === 'function'
          ? await (queue[curIndex] as () => Promise<T>)()
          : await queue[curIndex];
    }
  };

  // Start threads
  const threads: Promise<void>[] = [];
  for (let thread = 0; thread < concurrency; thread++) {
    threads.push(execThread());
  }
  await Promise.all(threads);
  return results;
};