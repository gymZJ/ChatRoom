import type { RuntimeEventBus } from "#app/event-bus";
import type { AgentStore } from "./store.js";
import type { AgentItem } from "./types.js";

export interface AgentInvalidation {
  turnIds?: readonly string[];
  itemIds?: readonly string[];
  deleted?: boolean;
}

interface PendingInvalidation {
  timer: ReturnType<typeof setTimeout>;
  turnIds: Set<string>;
  itemIds: Set<string>;
  persistedItems: Map<string, AgentItem>;
  deleted: boolean;
}

const DELTA_FLUSH_DELAY_MS = 150;

/**
 * Batches Agent change notifications per session. Streaming deltas are
 * coalesced for a short delay (and their item writes deferred with them);
 * structural changes flush immediately together with anything pending.
 */
export class AgentInvalidationBatcher {
  private readonly pending = new Map<string, PendingInvalidation>();
  private closed = false;

  constructor(
    private readonly store: Pick<AgentStore, "updateItem">,
    private readonly events: RuntimeEventBus,
    private readonly onFlushError: (sessionId: string, error: unknown) => void,
  ) {}

  /** Coalesces a delta notification, optionally deferring an item write. */
  schedule(
    sessionId: string,
    change: AgentInvalidation = {},
    persistedItem?: AgentItem,
  ): void {
    if (this.closed) return;
    const existing = this.pending.get(sessionId);
    if (existing) {
      merge(existing, change);
      if (persistedItem)
        existing.persistedItems.set(persistedItem.id, persistedItem);
      return;
    }
    const pending: PendingInvalidation = {
      timer: setTimeout(() => {
        try {
          this.flush(sessionId);
        } catch (error) {
          this.onFlushError(sessionId, error);
        }
      }, DELTA_FLUSH_DELAY_MS),
      turnIds: new Set(change.turnIds ?? []),
      itemIds: new Set(change.itemIds ?? []),
      persistedItems: new Map(
        persistedItem ? [[persistedItem.id, persistedItem]] : [],
      ),
      deleted: Boolean(change.deleted),
    };
    pending.timer.unref();
    this.pending.set(sessionId, pending);
  }

  /** Emits a notification now, folding in anything pending for the session. */
  invalidate(sessionId: string, change: AgentInvalidation = {}): void {
    const pending = this.pending.get(sessionId);
    const turnIds = new Set(change.turnIds ?? []);
    const itemIds = new Set(change.itemIds ?? []);
    let deleted = Boolean(change.deleted);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(sessionId);
      this.persistDeferred(pending);
      for (const id of pending.turnIds) turnIds.add(id);
      for (const id of pending.itemIds) itemIds.add(id);
      deleted ||= pending.deleted;
    }
    this.emit(sessionId, turnIds, itemIds, deleted);
  }

  /** Writes an item now, superseding any deferred write of the same item. */
  persistItem(sessionId: string, item: AgentItem): void {
    this.pending.get(sessionId)?.persistedItems.delete(item.id);
    this.store.updateItem(item);
  }

  /** Writes deferred items so reads observe the latest streamed state. */
  persistPending(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending) this.persistDeferred(pending);
  }

  /** Persists everything deferred and stops emitting notifications. */
  close(): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.persistDeferred(pending);
    }
    this.pending.clear();
  }

  private flush(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (!pending) return;
    this.pending.delete(sessionId);
    this.persistDeferred(pending);
    this.emit(sessionId, pending.turnIds, pending.itemIds, pending.deleted);
  }

  private emit(
    sessionId: string,
    turnIds: ReadonlySet<string>,
    itemIds: ReadonlySet<string>,
    deleted: boolean,
  ): void {
    if (this.closed) return;
    this.events.emit({
      type: "agent",
      sessionId,
      ...(turnIds.size ? { turnIds: [...turnIds] } : {}),
      ...(itemIds.size ? { itemIds: [...itemIds] } : {}),
      ...(deleted ? { deleted: true } : {}),
    });
  }

  private persistDeferred(pending: PendingInvalidation): void {
    for (const item of pending.persistedItems.values())
      this.store.updateItem(item);
    pending.persistedItems.clear();
  }
}

function merge(target: PendingInvalidation, change: AgentInvalidation): void {
  for (const id of change.turnIds ?? []) target.turnIds.add(id);
  for (const id of change.itemIds ?? []) target.itemIds.add(id);
  target.deleted ||= Boolean(change.deleted);
}
