import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type WatchSource,
} from "vue";
import {
  ApiError,
  api,
  type ProcessSnapshot,
  type ProcessSummary,
} from "../api.js";
import type { ProcessRefreshHint } from "./useRuntimeEvents.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";
import { createEntityRefreshQueue } from "../utils/entity-refresh-queue.js";

export function useProcesses(
  revision: WatchSource<number>,
  changes: () => ProcessRefreshHint[] | null,
) {
  const items = shallowRef<ProcessSummary[]>([]);
  const selected = shallowRef<string | null>(null);
  const detail = shallowRef<ProcessSnapshot | null>(null);
  const error = shallowRef("");
  const loading = shallowRef(false);
  const refreshRequests = createRequestGate();
  const detailRequests = createRequestGate();
  let initialStarted = false;
  let initialLoaded = false;
  const retryCounts = new Map<string, number>();
  const stopRequests = new Set<AbortController>();
  let selectionGeneration = 0;
  let disposed = false;
  const refreshQueue = createEntityRefreshQueue<ProcessRefreshHint>({
    keyOf: (change) => change.processId,
    merge: mergeProcessRefresh,
    isReady: () => initialLoaded,
    isLoading: () => loading.value,
    isDisposed: () => disposed,
    refreshAll: loadInitial,
    applyBatch: applyChangesBatch,
  });

  onScopeDispose(() => {
    disposed = true;
    initialLoaded = false;
    refreshQueue.reset();
    retryCounts.clear();
    refreshRequests.invalidate();
    detailRequests.invalidate();
    for (const request of stopRequests) request.abort();
    stopRequests.clear();
  });

  const processOutput = computed(() => {
    if (!detail.value) return "";
    const stderr = detail.value.stderr
      ? `\n\n[stderr]\n${detail.value.stderr}`
      : "";
    return `${detail.value.stdout}${stderr}`;
  });

  watch(
    revision,
    () => {
      if (!initialStarted) {
        initialStarted = true;
        void loadInitial();
        return;
      }
      refreshQueue.enqueue(changes());
    },
    { immediate: true },
  );
  watch(selected, () => {
    selectionGeneration += 1;
    void loadDetail(selectionGeneration);
  });

  async function loadInitial() {
    if (disposed) return;
    initialLoaded = false;
    const request = refreshRequests.begin();
    loading.value = true;
    error.value = "";
    try {
      const next = await api<ProcessSummary[]>("/processes", {
        signal: request.signal,
      });
      if (disposed || !refreshRequests.isCurrent(request)) return;
      items.value = next;
      initialLoaded = true;
      if (
        selected.value &&
        !next.some((item) => item.processId === selected.value)
      ) {
        clearSelection();
      } else if (selected.value) {
        void loadDetail();
      }
    } catch (cause) {
      if (refreshRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (refreshRequests.isCurrent(request)) {
        loading.value = false;
        if (initialLoaded) void refreshQueue.drain();
      }
    }
  }

  async function applyChangesBatch(nextChanges: ProcessRefreshHint[]) {
    if (disposed || !nextChanges.length) return;

    const request = refreshRequests.begin();
    error.value = "";
    const selectedAtStart = selected.value;
    const selectionAtStart = selectionGeneration;

    const settled = await Promise.allSettled(
      nextChanges.map(async (change): Promise<ProcessPatch> => {
        if (change.deleted)
          return { processId: change.processId, deleted: true };

        try {
          if (change.processId === selectedAtStart) {
            const snapshot = await api<ProcessSnapshot>(
              `/processes/${encodeURIComponent(change.processId)}`,
              { signal: request.signal },
            );
            return {
              processId: change.processId,
              deleted: false,
              summary: summaryOf(snapshot),
              snapshot,
            };
          }

          if (change.output && !change.summary)
            return {
              processId: change.processId,
              deleted: false,
              summary: null,
              snapshot: null,
            };

          const summary = await api<ProcessSummary>(
            `/processes/${encodeURIComponent(change.processId)}/summary`,
            { signal: request.signal },
          );
          return {
            processId: change.processId,
            deleted: false,
            summary,
            snapshot: null,
          };
        } catch (cause) {
          if (isStaleProcessError(cause))
            return { processId: change.processId, deleted: true };
          throw cause;
        }
      }),
    );

    if (disposed || !refreshRequests.isCurrent(request)) return;

    let nextItems = [...items.value];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const change = nextChanges[index]!;
      if (result.status === "rejected") {
        retryProcessChange(change, result.reason);
        continue;
      }

      retryCounts.delete(change.processId);
      const patch = result.value;
      if (patch.deleted) {
        nextItems = nextItems.filter(
          (item) => item.processId !== patch.processId,
        );
        if (selected.value === patch.processId) clearSelection();
        continue;
      }

      if (patch.summary) {
        const itemIndex = nextItems.findIndex(
          (item) => item.processId === patch.processId,
        );
        if (itemIndex >= 0) nextItems[itemIndex] = patch.summary;
        else nextItems.push(patch.summary);
      }

      if (
        patch.snapshot &&
        selected.value === patch.processId &&
        selectedAtStart === patch.processId &&
        selectionGeneration === selectionAtStart
      ) {
        detailRequests.invalidate();
        detail.value = patch.snapshot;
      }
    }

    items.value = nextItems.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    );
  }

  function retryProcessChange(change: ProcessRefreshHint, cause: unknown) {
    const attempts = (retryCounts.get(change.processId) ?? 0) + 1;
    if (attempts <= 1 && !disposed) {
      retryCounts.set(change.processId, attempts);
      refreshQueue.enqueue([change]);
      return;
    }
    retryCounts.delete(change.processId);
    error.value = errorMessage(cause);
  }

  async function loadDetail(selectionAtStart = selectionGeneration) {
    const request = detailRequests.begin();
    const processId = selected.value;
    if (!processId) {
      detail.value = null;
      return;
    }
    try {
      const next = await api<ProcessSnapshot>(
        `/processes/${encodeURIComponent(processId)}`,
        { signal: request.signal },
      );
      if (
        detailRequests.isCurrent(request) &&
        selected.value === processId &&
        selectionGeneration === selectionAtStart
      )
        detail.value = next;
    } catch (cause) {
      if (!detailRequests.isCurrent(request)) return;
      if (isStaleProcessError(cause)) {
        clearSelection();
        void loadInitial();
        return;
      }
      error.value = errorMessage(cause);
    }
  }

  async function stop(processId: string, force: boolean) {
    if (disposed) return;
    error.value = "";
    const request = new AbortController();
    stopRequests.add(request);
    let deleted = false;
    try {
      await api(
        `/processes/${encodeURIComponent(processId)}/${force ? "kill" : "terminate"}`,
        { method: "POST", signal: request.signal },
      );
    } catch (cause) {
      if (disposed || request.signal.aborted) return;
      if (!isStaleProcessError(cause)) {
        error.value = errorMessage(cause);
        return;
      }
      deleted = cause instanceof ApiError && cause.code === "NOT_FOUND";
    } finally {
      stopRequests.delete(request);
    }
    if (disposed || request.signal.aborted) return;
    // The POST snapshot precedes process exit/output events. Reconcile through
    // the same entity queue as SSE so its delayed response cannot undo them.
    refreshQueue.enqueue([{ processId, summary: true, output: true, deleted }]);
    if (initialLoaded) await refreshQueue.drain();
  }

  function select(processId: string) {
    if (selected.value === processId) return;
    detail.value = null;
    selected.value = processId;
  }

  function clearSelection() {
    selected.value = null;
    detail.value = null;
    detailRequests.invalidate();
  }

  return {
    items,
    selected,
    detail,
    error,
    loading,
    processOutput,
    loadInitial,
    select,
    clearSelection,
    stop,
  };
}

function mergeProcessRefresh(
  previous: ProcessRefreshHint | undefined,
  next: ProcessRefreshHint,
): ProcessRefreshHint {
  return {
    processId: next.processId,
    output: Boolean(previous?.output || next.output),
    summary: Boolean(previous?.summary || next.summary),
    deleted: Boolean(previous?.deleted || next.deleted),
  };
}

type ProcessPatch =
  | { processId: string; deleted: true }
  | {
      processId: string;
      deleted: false;
      summary: ProcessSummary | null;
      snapshot: ProcessSnapshot | null;
    };

function summaryOf(snapshot: ProcessSnapshot): ProcessSummary {
  return {
    processId: snapshot.processId,
    command: snapshot.command,
    args: snapshot.args,
    state: snapshot.state,
    startedAt: snapshot.startedAt,
    durationMs: snapshot.durationMs,
  };
}

function isStaleProcessError(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.code === "NOT_FOUND" || cause.code === "CONFLICT")
  );
}
