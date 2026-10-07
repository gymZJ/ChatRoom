import type {
  AgentHistory,
  AgentHistoryUpdate,
  AgentItem,
  AgentProviderSessionState,
  AgentSession,
  AgentTurn,
} from "./types.js";

export interface AgentStore {
  reconcileInterrupted(now: string): void;

  insertSession(session: AgentSession): void;
  updateSession(session: AgentSession): void;
  getSession(id: string): AgentSession | null;
  listSessions(): AgentSession[];
  deleteSession(id: string): void;

  getProviderState(
    sessionId: string,
    provider: AgentProviderSessionState["provider"],
  ): AgentProviderSessionState | null;
  upsertProviderState(state: AgentProviderSessionState): void;

  insertTurn(turn: AgentTurn): void;
  updateTurn(turn: AgentTurn): void;

  insertItem(item: AgentItem): void;
  updateItem(item: AgentItem): void;

  history(sessionId: string): AgentHistory | null;
  historyUpdate(
    sessionId: string,
    turnIds: readonly string[],
    itemIds: readonly string[],
  ): AgentHistoryUpdate | null;
}
