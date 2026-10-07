import { onScopeDispose, shallowRef, watch, type WatchSource } from "vue";
import { ApiError, api, type Operation } from "../api.js";
import type {
  OperationRefreshBatch,
  OperationRefreshHint,
} from "./useRuntimeEvents.js";
import { errorMessage } from "../utils/errors.js";
import { createRequestGate } from "../utils/requests.js";
import { createEntityRefreshQueue } from "../utils/entity-refresh-queue.js";

const PAGE_SIZE = 50;
const MAX_VISIBLE_OPERATIONS = 1000;

export function useOperations(
  revision: WatchSource<number>,
  changes: () => OperationRefreshBatch | null,
) {
  const events = shallowRef<Operation[]>([]);
  const selected = shallowRef<string | null>(null);
  const detail = shallowRef<Operation | null>(null);
  const filter = shallowRef("all");
  const loading = shallowRef(false);
  const loadingMore = shallowRef(false);
  const hasMore = shallowRef(false);
  const clearing = shallowRef(false);
  const error = shallowRef("");
  const limitReached = shallowRef(false);

  const listRequests = createRequestGate();
  const detailRequests = createRequestGate();
  const patchRequests = createRequestGate();
  const retryCounts = new Map<string, number>();
  let initialLoaded = false;
  let pageCursor: { startedAt: string; operationId: string } | null = null;
  let selectionGeneration = 0;
  let disposed = false;
  const refreshQueue = createEntityRefreshQueue<OperationRefreshHint>({
    keyOf: (change) => change.operationId,
    merge: (_previous, next) => next,
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
    listRequests.invalidate();
    detailRequests.invalidate();
    patchRequests.invalidate();
  });

  watch(
    filter,
    () => {
      initialLoaded = false;
      pageCursor = null;
      refreshQueue.reset();
      patchRequests.invalidate();
      void loadInitial();
    },
    { immediate: true },
  );

  watch(revision, () => {
    enqueueOperationChanges(changes());
  });

  watch(selected, () => {
    selectionGeneration += 1;
    void loadDetail(selectionGeneration);
  });

  function operationsUrl(
    limit: number,
    cursor: { startedAt: string; operationId: string } | null = null,
  ): string {
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter.value !== "all") params.set("status", filter.value);
    if (cursor) {
      params.set("beforeStartedAt", cursor.startedAt);
      params.set("beforeOperationId", cursor.operationId);
    }
    return `/operations?${params}`;
  }

  async function loadInitial() {
    if (disposed) return;
    initialLoaded = false;
    const request = listRequests.begin();
    loading.value = true;
    loadingMore.value = false;
    error.value = "";
    try {
      const page = await api<Operation[]>(operationsUrl(PAGE_SIZE), {
        signal: request.signal,
      });
      if (disposed || !listRequests.isCurrent(request)) return;
      events.value = page.slice(0, MAX_VISIBLE_OPERATIONS);
      limitReached.value = false;
      pageCursor = pageCursorFrom(page);
      hasMore.value = page.length === PAGE_SIZE;
      initialLoaded = true;

      if (selected.value) {
        const selectedInPage = page.find(
          (item) => item.operationId === selected.value,
        );
        if (selectedInPage) {
          detailRequests.invalidate();
          detail.value = selectedInPage;
        } else {
          void loadDetail(selectionGeneration);
        }
      }
    } catch (cause) {
      if (listRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (listRequests.isCurrent(request)) {
        loading.value = false;
        if (initialLoaded) void refreshQueue.drain();
      }
    }
  }

  async function loadMore() {
    if (loading.value || loadingMore.value || !hasMore.value) return;
    const request = listRequests.begin();
    const cursor = pageCursor;
    loadingMore.value = true;
    try {
      const page = await api<Operation[]>(operationsUrl(PAGE_SIZE, cursor), {
        signal: request.signal,
      });
      if (disposed || !listRequests.isCurrent(request)) return;
      if (page.length) pageCursor = pageCursorFrom(page);
      const known = new Set(events.value.map((item) => item.operationId));
      const merged = [
        ...events.value,
        ...page.filter((item) => !known.has(item.operationId)),
      ];
      events.value = merged.slice(0, MAX_VISIBLE_OPERATIONS);
      limitReached.value =
        merged.length > MAX_VISIBLE_OPERATIONS ||
        (events.value.length >= MAX_VISIBLE_OPERATIONS &&
          page.length === PAGE_SIZE);
      hasMore.value = !limitReached.value && page.length === PAGE_SIZE;
    } catch (cause) {
      if (listRequests.isCurrent(request)) error.value = errorMessage(cause);
    } finally {
      if (listRequests.isCurrent(request)) loadingMore.value = false;
    }
  }

  async function applyChangesBatch(next: OperationRefreshHint[]) {
    if (disposed || !next.length) return;

    const request = patchRequests.begin();
    const selectedAtStart = selected.value;
    const selectionAtStart = selectionGeneration;
    const settled = await Promise.allSettled(
      next.map(async (change) => {
        try {
          return await api<Operation>(
            `/operations/${encodeURIComponent(change.operationId)}`,
            { signal: request.signal },
          );
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 404) return null;
          throw cause;
        }
      }),
    );
    if (disposed || !patchRequests.isCurrent(request)) return;

    let nextEvents = [...events.value];
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index]!;
      const change = next[index]!;
      if (result.status === "rejected") {
        retryOperationChange(change, result.reason);
        continue;
      }

      retryCounts.delete(change.operationId);
      const patch = result.value;
      if (!patch) continue;
      const eventIndex = nextEvents.findIndex(
        (item) => item.operationId === patch.operationId,
      );

      if (!matchesFilter(patch, filter.value)) {
        if (eventIndex >= 0) nextEvents.splice(eventIndex, 1);
      } else if (eventIndex >= 0) {
        nextEvents[eventIndex] = patch;
      } else {
        nextEvents.push(patch);
      }

      if (
        selected.value === patch.operationId &&
        selectedAtStart === patch.operationId &&
        selectionGeneration === selectionAtStart
      ) {
        detailRequests.invalidate();
        detail.value = patch;
      }
    }

    nextEvents.sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        right.operationId.localeCompare(left.operationId),
    );
    if (nextEvents.length > MAX_VISIBLE_OPERATIONS) {
      limitReached.value = true;
      hasMore.value = false;
    }
    events.value = nextEvents.slice(0, MAX_VISIBLE_OPERATIONS);
  }

  function retryOperationChange(change: OperationRefreshHint, cause: unknown) {
    const attempts = (retryCounts.get(change.operationId) ?? 0) + 1;
    if (attempts <= 1 && !disposed) {
      retryCounts.set(change.operationId, attempts);
      refreshQueue.enqueue([change]);
      return;
    }
    retryCounts.delete(change.operationId);
    error.value = errorMessage(cause);
  }

  async function loadDetail(selectionAtStart = selectionGeneration) {
    const operationId = selected.value;
    const request = detailRequests.begin();
    if (!operationId) {
      detail.value = null;
      return;
    }
    try {
      const next = await api<Operation>(
        `/operations/${encodeURIComponent(operationId)}`,
        { signal: request.signal },
      );
      if (
        detailRequests.isCurrent(request) &&
        selected.value === operationId &&
        selectionGeneration === selectionAtStart
      )
        detail.value = next;
    } catch (cause) {
      if (!detailRequests.isCurrent(request)) return;
      if (cause instanceof ApiError && cause.status === 404) {
        if (
          selected.value === operationId &&
          selectionGeneration === selectionAtStart
        )
          clearSelection();
        return;
      }
      error.value = errorMessage(cause);
    }
  }

  async function clearHistory() {
    if (clearing.value) return false;
    clearing.value = true;
    error.value = "";
    listRequests.invalidate();
    patchRequests.invalidate();
    detailRequests.invalidate();
    try {
      await api("/operations", { method: "DELETE" });
      selected.value = null;
      detail.value = null;
      initialLoaded = false;
      pageCursor = null;
      await loadInitial();
      return true;
    } catch (cause) {
      error.value = errorMessage(cause);
      return false;
    } finally {
      clearing.value = false;
    }
  }

  function select(event: Operation) {
    selected.value = event.operationId;
    detail.value = event;
  }

  function clearSelection() {
    selected.value = null;
    detail.value = null;
    detailRequests.invalidate();
  }

  function enqueueOperationChanges(next: OperationRefreshBatch | null) {
    if (disposed) return;
    if (next === null) {
      refreshQueue.enqueue(null);
      return;
    }
    if (!next.clearAll) {
      refreshQueue.enqueue(next.changes);
      return;
    }

    patchRequests.invalidate();
    retryCounts.clear();
    refreshQueue.reset();
    selected.value = null;
    detail.value = null;
    detailRequests.invalidate();
    events.value = [];
    pageCursor = null;
    hasMore.value = false;
    limitReached.value = false;
    initialLoaded = false;
    void loadInitial();
  }

  return {
    events,
    selected,
    detail,
    filter,
    loading,
    loadingMore,
    hasMore,
    clearing,
    error,
    limitReached,
    loadInitial,
    loadMore,
    select,
    clearSelection,
    clearHistory,
  };
}

function pageCursorFrom(
  page: readonly Operation[],
): { startedAt: string; operationId: string } | null {
  const last = page.at(-1);
  return last
    ? { startedAt: last.startedAt, operationId: last.operationId }
    : null;
}

function matchesFilter(operation: Operation, filter: string): boolean {
  return filter === "all" || operation.status === filter;
}
