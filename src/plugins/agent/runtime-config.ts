import { ChatRoomError } from "#core/errors/chatroom-error";
import type {
  AgentProviderNativeSetting,
  AgentReviewTarget,
  AgentSessionConfig,
} from "./types.js";

export function emptyAgentSessionConfig(): AgentSessionConfig {
  return {
    model: null,
    reasoningEffort: null,
    reasoningSummary: null,
    serviceTier: null,
    approvalPolicy: null,
    approvalsReviewer: null,
    permissionMode: null,
  };
}

export function copyAgentSessionConfig(
  config: AgentSessionConfig,
): AgentSessionConfig {
  return {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    reasoningSummary: config.reasoningSummary,
    serviceTier: config.serviceTier,
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    permissionMode: config.permissionMode,
  };
}

export function approvalPolicySupported(
  value: AgentSessionConfig["approvalPolicy"],
  setting: AgentProviderNativeSetting,
): boolean {
  if (value === null) return false;
  if (typeof value === "string")
    return setting.options.some((option) => option.id === value);
  if (!setting.options.some((option) => option.id === "granular")) return false;
  const granular = value.granular;
  return (
    typeof granular.sandbox_approval === "boolean" &&
    typeof granular.rules === "boolean" &&
    typeof granular.skill_approval === "boolean" &&
    typeof granular.request_permissions === "boolean" &&
    typeof granular.mcp_elicitations === "boolean"
  );
}

export function validateReviewTarget(target: AgentReviewTarget): void {
  if (!target || typeof target !== "object")
    throw new ChatRoomError("INVALID_INPUT", "Invalid review target");
  switch (target.type) {
    case "uncommittedChanges":
      return;
    case "baseBranch":
      if (typeof target.branch === "string" && target.branch.trim()) return;
      break;
    case "commit":
      if (
        typeof target.sha === "string" &&
        target.sha.trim() &&
        (target.title === null || typeof target.title === "string")
      )
        return;
      break;
    case "custom":
      if (typeof target.instructions === "string" && target.instructions.trim())
        return;
      break;
  }
  throw new ChatRoomError("INVALID_INPUT", "Invalid review target");
}
