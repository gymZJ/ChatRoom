import type { Operation, OperationStatus, OperationSummary } from "./types.js";

export interface OperationQuery {
  limit?: number;
  offset?: number;
  beforeStartedAt?: string;
  beforeOperationId?: string;
  pluginId?: string;
  status?: OperationStatus | string;
}

export interface OperationRepository {
  insert(operation: Operation): void;
  update(operation: Operation): void;
  get(operationId: string): Operation | null;
  list(query?: OperationQuery): Operation[];
  listSummaries(query?: OperationQuery): OperationSummary[];
  clearHistory(): { deleted: number; preserved: number };
  /**
   * Deletes finished operations that started before `startedBefore` or fall
   * outside the newest `keepLatest` finished operations. Returns the count.
   */
  prune(options: { startedBefore: string; keepLatest: number }): number;
  reconcileRunning(finishedAt: string): number;
}
