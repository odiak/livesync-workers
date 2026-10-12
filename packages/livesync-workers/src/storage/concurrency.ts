/** Bound in-flight I/O and settle every started operation before propagating an error. */
export async function mapBatches<T, U>(
  values: readonly T[],
  limit: number,
  work: (value: T) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  for (let offset = 0; offset < values.length; offset += limit) {
    const settled = await Promise.allSettled(values.slice(offset, offset + limit).map(work));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
  }
  return results;
}

/** One shared budget across recursive or nested I/O. */
export function limitConcurrency(limit: number) {
  let available = limit;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (available) available--;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else available++;
    }
  };
}
