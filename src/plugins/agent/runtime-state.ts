import { randomUUID } from "node:crypto";
import type { ProviderItem } from "./provider.js";
import type {
  AgentError,
  AgentHistory,
  AgentInputQuestion,
  AgentInteractionOption,
  AgentItem,
  AgentTurnSource,
} from "./types.js";

const CONTINUITY_CONTEXT_LIMIT = 64 * 1024;

export function nextSessionUpdatedAt(current: string): string {
  const currentMs = Date.parse(current);
  const nextMs = Math.max(
    Date.now(),
    Number.isFinite(currentMs) ? currentMs + 1 : 0,
  );
  return new Date(nextMs).toISOString();
}

export function materializeProviderItem(
  turnId: string,
  providerItemId: string,
  sequence: number,
  status: AgentItem["status"],
  item: ProviderItem,
  existing?: AgentItem,
): AgentItem {
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? "item_" + randomUUID(),
    turnId,
    providerItemId,
    sequence,
    status,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...item,
  } as AgentItem;
}

export function materializeInteraction(
  turnId: string,
  providerItemId: string,
  sequence: number,
  interaction: {
    id: string;
    kind: "approval" | "input";
    title: string;
    description: string | null;
    questions: AgentInputQuestion[];
    approvalOptions: AgentInteractionOption[];
  },
): AgentItem {
  const now = new Date().toISOString();
  return {
    id: "item_" + randomUUID(),
    turnId,
    providerItemId,
    sequence,
    status: "waiting",
    createdAt: now,
    updatedAt: now,
    type: "interaction",
    interaction: {
      kind: interaction.kind,
      title: interaction.title,
      description: interaction.description,
      questions: interaction.questions,
      approvalOptions: interaction.approvalOptions,
      response: null,
    },
  };
}

export function applyItemDelta(
  item: AgentItem,
  field: "text" | "output",
  delta: string,
): AgentItem {
  const updatedAt = new Date().toISOString();
  if (field === "text") {
    if (
      item.type === "assistant_message" ||
      item.type === "plan" ||
      item.type === "reasoning_summary"
    )
      return { ...item, text: item.text + delta, updatedAt };
    if (item.type === "notice")
      return { ...item, text: item.text + delta, updatedAt };
  }
  if (field === "output" && item.type === "command")
    return { ...item, output: item.output + delta, updatedAt };
  return { ...item, updatedAt };
}

export function buildContinuityDelta(
  history: AgentHistory,
  afterTurnId: string | null,
): string {
  let startIndex = 0;
  if (afterTurnId) {
    const index = history.turns.findIndex(
      (entry) => entry.turn.id === afterTurnId,
    );
    if (index >= 0) startIndex = index + 1;
  }

  const lines: string[] = [];
  for (const entry of history.turns.slice(startIndex)) {
    for (const item of entry.items) {
      const line = continuityLine(item, entry.turn.source);
      if (line) lines.push(line);
    }
  }
  return lines.join("\n\n");
}

export function mergeContinuityContext(
  existing: string,
  delta: string,
): string {
  if (!delta) return existing;
  let merged = existing ? existing + "\n\n" + delta : delta;
  if (merged.length > CONTINUITY_CONTEXT_LIMIT)
    merged =
      "[Earlier cross-provider context omitted]\n\n" +
      merged.slice(merged.length - CONTINUITY_CONTEXT_LIMIT);
  return merged;
}

function continuityLine(
  item: AgentItem,
  source: AgentTurnSource,
): string | null {
  if (item.type === "user_message") {
    const attachments = item.attachments.length
      ? "\nAttachments: " +
        item.attachments
          .map((attachment) => `${attachment.name} (${attachment.path})`)
          .join(", ")
      : "";
    return `User [${item.source ?? source}]: ${item.text}${attachments}`;
  }
  if (item.type === "assistant_message") return "Assistant: " + item.text;
  if (item.type === "plan")
    return (
      "Plan: " +
      item.text +
      "\n" +
      item.steps.map((step) => `[${step.status}] ${step.step}`).join("\n")
    );
  if (item.type === "command")
    return (
      "Command: " +
      item.command +
      (item.exitCode === null ? "" : " (exit " + item.exitCode + ")") +
      (item.output ? "\n" + item.output.slice(-2000) : "")
    );
  if (item.type === "file_change")
    return (
      "Files changed: " +
      item.changes.map((change) => change.kind + " " + change.path).join(", ")
    );
  if (item.type === "tool")
    return "Tool: " + (item.server ? item.server + "/" : "") + item.name;
  if (item.type === "artifact") return "Artifact: " + item.artifact.path;
  if (item.type === "interaction" && item.interaction.response)
    return (
      "Interaction: " +
      item.interaction.title +
      "\nResponse: " +
      JSON.stringify(item.interaction.response)
    );
  if (item.type === "notice" && item.level !== "info")
    return "Notice: " + item.text;
  return null;
}

export function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function structuredError(error: unknown): AgentError {
  const details =
    error && typeof error === "object" ? (error as Partial<AgentError>) : null;
  return {
    message:
      typeof details?.message === "string"
        ? details.message
        : runtimeErrorMessage(error),
    details: typeof details?.details === "string" ? details.details : null,
    providerData: details?.providerData ?? null,
  };
}
