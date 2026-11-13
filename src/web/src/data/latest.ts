/**
 * One owner for "latest request wins" lifecycles. Callers begin a task, use its
 * signal and generation check after each await, and finish it in one place.
 * Beginning a newer task aborts the previous request and invalidates its results.
 */
export interface LatestTask {
  begin(): { signal: AbortSignal; isCurrent(): boolean; finish(): void };
  cancel(): void;
  readonly active: boolean;
}

export function createLatestTask(): LatestTask {
  let generation = 0;
  let controller: AbortController | undefined;
  return {
    begin() {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const owner = ++generation;
      return {
        signal: request.signal,
        isCurrent: () => owner === generation,
        finish: () => {
          if (owner === generation) controller = undefined;
        },
      };
    },
    cancel() {
      generation++;
      controller?.abort();
      controller = undefined;
    },
    get active() {
      return controller !== undefined;
    },
  };
}
