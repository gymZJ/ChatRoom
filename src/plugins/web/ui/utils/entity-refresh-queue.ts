interface EntityRefreshQueueOptions<T> {
  keyOf(change: T): string;
  merge(previous: T | undefined, next: T): T;
  isReady(): boolean;
  isLoading(): boolean;
  isDisposed(): boolean;
  refreshAll(): Promise<void>;
  applyBatch(batch: T[]): Promise<void>;
}

export function createEntityRefreshQueue<T>(
  options: EntityRefreshQueueOptions<T>,
) {
  const pending = new Map<string, T>();
  let globalRefresh = false;
  let worker: Promise<void> | null = null;

  function enqueue(changes: readonly T[] | null) {
    if (options.isDisposed()) return;
    if (changes === null) {
      globalRefresh = true;
      pending.clear();
    } else if (!globalRefresh) {
      for (const change of changes) {
        const key = options.keyOf(change);
        pending.set(key, options.merge(pending.get(key), change));
      }
    }

    if (options.isReady()) void drain();
    else if (!options.isLoading()) void options.refreshAll();
  }

  function drain(): Promise<void> {
    if (worker) return worker;
    worker = Promise.resolve()
      .then(async () => {
        while (
          !options.isDisposed() &&
          options.isReady() &&
          (globalRefresh || pending.size)
        ) {
          if (globalRefresh) {
            globalRefresh = false;
            pending.clear();
            await options.refreshAll();
            continue;
          }
          const batch = [...pending.values()];
          pending.clear();
          await options.applyBatch(batch);
        }
      })
      .finally(() => {
        worker = null;
        if (
          !options.isDisposed() &&
          options.isReady() &&
          (globalRefresh || pending.size)
        )
          void drain();
      });
    return worker;
  }

  function reset() {
    pending.clear();
    globalRefresh = false;
  }

  return { enqueue, drain, reset };
}
