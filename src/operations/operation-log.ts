import { randomUUID } from "node:crypto";
import type {
  Operation,
  OperationStart,
  OperationStatus,
  OperationSummary,
} from "#core/operations/types";
import { boundJson } from "#core/operations/bounded-value";
import { SecretRedactor } from "#core/operations/redactor";
import { asChatRoomError, ChatRoomError } from "#core/errors/chatroom-error";
import type {
  OperationQuery,
  OperationRepository,
} from "#core/operations/repository";
import type { RuntimeEventBus } from "#app/event-bus";

export interface OperationRetention {
  /** Finished operations older than this are deleted. */
  maxAgeDays: number;
  /** At most this many finished operations are kept. */
  maxEntries: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export class OperationLog {
  private readonly redactor = new SecretRedactor();
  private retentionTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: OperationRepository,
    private readonly eventBus: RuntimeEventBus,
    private readonly maxPayloadBytes: number,
    private readonly retention: OperationRetention | null = null,
  ) {}

  start(request: OperationStart): Operation {
    const input = boundJson(
      this.redactor.redact(request.input ?? null),
      this.maxPayloadBytes,
    );
    const operation: Operation = {
      operationId: randomUUID(),
      pluginId: request.pluginId,
      source: request.source,
      action: request.action,
      status: "running",
      processId: request.processId ?? null,
      input: input.value,
      output: null,
      error: null,
      inputTruncated: input.truncated,
      outputTruncated: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
    };
    this.repository.insert(operation);
    this.eventBus.emit({
      type: "operation",
      operationId: operation.operationId,
      pluginId: operation.pluginId,
    });
    return operation;
  }

  finish(
    operationId: string,
    status: Exclude<OperationStatus, "running">,
    output?: unknown,
    error?: unknown,
  ): Operation {
    const operation = this.require(operationId);
    const finishedAt = new Date();
    const bounded = boundJson(
      this.redactor.redact(output ?? null),
      this.maxPayloadBytes,
    );
    operation.status = status;
    operation.output = bounded.value;
    operation.outputTruncated = bounded.truncated;
    operation.error = error
      ? boundJson(this.redactor.redact(error), this.maxPayloadBytes).value
      : null;
    operation.finishedAt = finishedAt.toISOString();
    operation.durationMs = Math.max(
      0,
      finishedAt.getTime() - new Date(operation.startedAt).getTime(),
    );
    this.repository.update(operation);
    this.eventBus.emit({
      type: "operation",
      operationId: operation.operationId,
      pluginId: operation.pluginId,
    });
    return operation;
  }

  async run<T>(request: OperationStart, action: () => Promise<T>): Promise<T> {
    const operation = this.start(request);
    try {
      const result = await action();
      this.finish(operation.operationId, "success", result);
      return result;
    } catch (error) {
      const normalized = asChatRoomError(error);
      this.finish(operation.operationId, "error", null, {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
      });
      throw error;
    }
  }

  list(query?: OperationQuery): Operation[] {
    return this.repository.list(query);
  }

  /** Lists operation metadata without loading recorded payloads. */
  listSummaries(query?: OperationQuery): OperationSummary[] {
    return this.repository.listSummaries(query);
  }

  get(operationId: string): Operation | null {
    return this.repository.get(operationId);
  }

  associate(
    operationId: string,
    references: { processId?: string | null },
  ): Operation {
    const operation = this.require(operationId);
    if (references.processId !== undefined)
      operation.processId = references.processId;
    this.repository.update(operation);
    this.eventBus.emit({
      type: "operation",
      operationId: operation.operationId,
      pluginId: operation.pluginId,
    });
    return operation;
  }

  clearHistory(): { deleted: number; preserved: number } {
    const result = this.repository.clearHistory();
    this.eventBus.emit({ type: "operations-cleared" });
    return result;
  }

  reconcileInterrupted(): number {
    return this.repository.reconcileRunning(new Date().toISOString());
  }

  /**
   * Applies the retention policy; returns the number of deleted entries.
   * No event is emitted: pruned entries are old, and "operations-cleared"
   * would reset what an open Operations view has selected.
   */
  prune(now = new Date()): number {
    if (!this.retention) return 0;
    return this.repository.prune({
      startedBefore: new Date(
        now.getTime() - this.retention.maxAgeDays * DAY_MS,
      ).toISOString(),
      keepLatest: this.retention.maxEntries,
    });
  }

  /** Prunes now and then hourly until {@link stopRetention}. */
  startRetention(): number {
    this.stopRetention();
    if (!this.retention) return 0;
    this.retentionTimer = setInterval(() => {
      try {
        this.prune();
      } catch {
        // Retention is best effort; the next interval retries.
      }
    }, RETENTION_INTERVAL_MS);
    this.retentionTimer.unref();
    return this.prune();
  }

  stopRetention(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
  }

  private require(operationId: string): Operation {
    const operation = this.repository.get(operationId);
    if (!operation)
      throw new ChatRoomError(
        "NOT_FOUND",
        `Operation not found: ${operationId}`,
      );
    return operation;
  }
}
