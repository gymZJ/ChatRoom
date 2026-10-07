import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type {
  AgentProviderContext,
  ProviderEvent,
  ProviderItem,
  ProviderSession,
  ProviderTurnInput,
} from "#plugins/agent/provider";
import type {
  AgentError,
  AgentInputQuestion,
  AgentInteractionOption,
  AgentProviderDetails,
  AgentReviewTarget,
} from "#plugins/agent/types";
import { CodexRpcClient } from "./rpc.js";
import {
  array,
  questionOptions,
  record,
  stringifyOptional,
  continuityInstructions,
  workspaceInstructions,
} from "../common.js";

type SessionConfig = Parameters<ProviderSession["configure"]>[0];
type ApprovalChoice = AgentInteractionOption & { result: unknown };

export function codexItem(
  item: Record<string, unknown>,
  workspaceRoot: string,
): ProviderItem | null {
  const type = item.type;
  if (type === "agentMessage")
    return {
      type: "assistant_message",
      phase:
        item.phase === "commentary" || item.phase === "final_answer"
          ? item.phase
          : null,
      text: typeof item.text === "string" ? item.text : "",
    };
  if (type === "contextCompaction")
    return { type: "context_compaction", trigger: null, error: null };
  if (type === "reasoning")
    return {
      type: "reasoning_summary",
      text: array(item.summary)
        .filter((part): part is string => typeof part === "string")
        .join("\n"),
    };
  if (type === "plan")
    return {
      type: "plan",
      text: typeof item.text === "string" ? item.text : "",
      steps: [],
    };
  if (type === "commandExecution")
    return {
      type: "command",
      command: typeof item.command === "string" ? item.command : "",
      cwd: stringOrNull(item.cwd),
      output: stringOrNull(item.aggregatedOutput) ?? "",
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    };
  if (type === "fileChange")
    return {
      type: "file_change",
      changes: codexFileChanges(item.changes),
    };
  if (type === "mcpToolCall")
    return {
      type: "tool",
      name: stringOrNull(item.tool) ?? "MCP tool",
      server: stringOrNull(item.server),
      input: item.arguments ?? null,
      output: item.result ?? null,
      error: stringOrNull(record(item.error)?.message),
      progress: null,
    };
  if (type === "functionCallOutput")
    return {
      type: "tool",
      name: stringOrNull(item.name) ?? "Tool",
      server: stringOrNull(item.namespace),
      input: null,
      output: item.output ?? null,
      error: null,
      progress: null,
    };
  if (type === "dynamicToolCall")
    return {
      type: "tool",
      progress: null,
      name: typeof item.tool === "string" ? item.tool : "Tool",
      server: stringOrNull(item.namespace),
      input: item.arguments ?? null,
      output: item.contentItems ?? null,
      error: item.success === false ? "Tool call failed" : null,
    };
  if (type === "webSearch")
    return {
      type: "tool",
      progress: null,
      name: "web_search",
      server: null,
      input: null,
      output: item,
      error: null,
    };
  if (type === "imageView" && typeof item.path === "string")
    return artifactFromPath(item.path, workspaceRoot);
  if (type === "imageGeneration") {
    if (typeof item.savedPath === "string")
      return generatedArtifactFromPath(item.savedPath, workspaceRoot);
    return {
      type: "notice",
      level: item.failure ? "error" : "info",
      text: item.failure
        ? (stringifyOptional(item.failure) ?? "Image generation failed")
        : "Generating image…",
    };
  }
  return null;
}

function generatedArtifactFromPath(
  value: string,
  workspaceRoot: string,
): ProviderItem {
  const existing = artifactFromPath(value, workspaceRoot);
  if (existing.type === "artifact") return existing;

  const source = path.resolve(value);
  const mime = imageMime(source);
  if (!mime || !existsSync(source) || !statSync(source).isFile())
    return existing;

  return {
    type: "artifact",
    artifact: {
      kind: "image",
      name: path.basename(source),
      path: source,
      mimeType: mime,
    },
  };
}

function artifactFromPath(value: string, workspaceRoot: string): ProviderItem {
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      type: "notice",
      level: "warning",
      text: "Agent produced an artifact outside the workspace: " + value,
    };
  }
  const safePath = relative.split(path.sep).join("/");
  return {
    type: "artifact",
    artifact: {
      kind: imageMime(safePath) ? "image" : "file",
      name: path.basename(safePath),
      path: safePath,
      mimeType: imageMime(safePath),
    },
  };
}

export function codexFileChanges(value: unknown) {
  return array(value)
    .map(record)
    .filter((change): change is Record<string, unknown> => Boolean(change))
    .map((change) => {
      const kind = record(change.kind);
      const type =
        kind?.type === "add" ||
        kind?.type === "delete" ||
        kind?.type === "update"
          ? kind.type
          : "update";
      return {
        path: typeof change.path === "string" ? change.path : "",
        kind: type,
        movePath:
          type === "update" && typeof kind?.move_path === "string"
            ? kind.move_path
            : null,
        diff: typeof change.diff === "string" ? change.diff : "",
      };
    });
}

export function codexItemFailed(item: Record<string, unknown>): boolean {
  if (item.type === "commandExecution")
    return typeof item.exitCode === "number" && item.exitCode !== 0;
  if (item.type === "dynamicToolCall") return item.success === false;
  if (item.type === "mcpToolCall")
    return item.status === "failed" || Boolean(item.error);
  if (item.type === "imageGeneration") return Boolean(item.failure);
  return false;
}

export function grantedPermissions(
  requested: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const network = record(requested.network);
  const fileSystem = record(requested.fileSystem);
  if (network) output.network = network;
  if (fileSystem) output.fileSystem = fileSystem;
  return output;
}

export function codexQuestions(value: unknown): AgentInputQuestion[] {
  return array(value)
    .map(record)
    .filter((question): question is Record<string, unknown> =>
      Boolean(question),
    )
    .map((question, index) => {
      const id =
        typeof question.id === "string" ? question.id : "question_" + index;
      const options = questionOptions(question.options);
      return {
        id,
        label: typeof question.header === "string" ? question.header : id,
        question:
          typeof question.question === "string"
            ? question.question
            : "Provide input",
        options,
        multiSelect: Boolean(question.isMultiSelect ?? question.multiSelect),
        allowFreeText: Boolean(question.isOther) || options.length === 0,
        secret: Boolean(question.isSecret),
      };
    });
}

function resolveAttachmentPath(root: string, attachmentPath: string): string {
  const absolute = path.resolve(root, attachmentPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Attachment is outside the workspace");
  return absolute;
}

function imageMime(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    default:
      return null;
  }
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function codexVersion(userAgent: string): string | null {
  const match = userAgent.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export async function injectWorkspacePrompt(
  client: CodexRpcClient,
  threadId: string,
  prompt: string | null,
): Promise<void> {
  if (!prompt) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: workspaceInstructions(prompt),
          },
        ],
      },
    ],
  });
}

export async function injectContinuity(
  client: CodexRpcClient,
  threadId: string,
  context: string | null,
): Promise<void> {
  if (!context) return;
  await client.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "developer",
        content: [
          {
            type: "input_text",
            text: continuityInstructions(context),
          },
        ],
      },
    ],
  });
}

export function sessionConfig(context: AgentProviderContext): SessionConfig {
  return {
    model: context.model,
    reasoningEffort: context.reasoningEffort,
    reasoningSummary: context.reasoningSummary,
    serviceTier: context.serviceTier,
    approvalPolicy: context.approvalPolicy,
    approvalsReviewer: context.approvalsReviewer,
    permissionMode: context.permissionMode,
  };
}

export function standardApprovalChoices(): ApprovalChoice[] {
  return [
    { id: "accept", label: "Allow", description: null },
    {
      id: "acceptForSession",
      label: "Allow for this session",
      description: null,
    },
    { id: "decline", label: "Deny", description: null },
    { id: "cancel", label: "Cancel turn", description: null },
  ].map((choice) => ({ ...choice, result: { decision: choice.id } }));
}

export function turnError(value: unknown): AgentError | null {
  const error = record(value);
  if (!error || typeof error.message !== "string") return null;
  const errorInfo = error.codexErrorInfo ?? null;
  const misalignment = error.misalignment ?? null;
  return {
    message: error.message,
    details: stringOrNull(error.additionalDetails),
    providerData:
      errorInfo !== null || misalignment !== null
        ? { errorInfo, misalignment }
        : null,
  };
}

export function codexAccountUsage(
  value: unknown,
): AgentProviderDetails["accountUsage"] {
  const response = record(value);
  const limits = record(response?.rateLimits);
  if (!limits) return null;

  const windows: NonNullable<AgentProviderDetails["accountUsage"]>["windows"] =
    [];
  const addWindow = (id: string, raw: unknown) => {
    const window = record(raw);
    if (!window) return;
    const duration =
      typeof window.windowDurationMins === "number"
        ? window.windowDurationMins
        : null;
    const resetSeconds =
      typeof window.resetsAt === "number" ? window.resetsAt : null;
    windows.push({
      id,
      label:
        duration === 300 || duration === 10080 || duration === null
          ? null
          : formatCodexWindow(duration),
      utilization:
        typeof window.usedPercent === "number" ? window.usedPercent : null,
      resetsAt:
        resetSeconds === null
          ? null
          : new Date(resetSeconds * 1000).toISOString(),
    });
  };

  addWindow("five_hour", limits.primary);
  addWindow("seven_day", limits.secondary);

  return {
    subscriptionType:
      typeof limits.planType === "string" ? limits.planType : null,
    windows,
    extraUsage: null,
    updatedAt: new Date().toISOString(),
  };
}

function formatCodexWindow(minutes: number): string {
  if (minutes % 1440 === 0) return minutes / 1440 + " days";
  if (minutes % 60 === 0) return minutes / 60 + " hours";
  return minutes + " minutes";
}

export function tokenUsage(
  value: unknown,
): Extract<ProviderEvent, { type: "token.usage" }>["usage"] | null {
  const usage = record(value);
  if (!usage) return null;
  const breakdown = (value: unknown) => {
    const entry = record(value);
    if (!entry) return null;
    const {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
    } = entry;
    if (
      typeof totalTokens !== "number" ||
      typeof inputTokens !== "number" ||
      typeof cachedInputTokens !== "number" ||
      typeof cacheWriteInputTokens !== "number" ||
      typeof outputTokens !== "number" ||
      typeof reasoningOutputTokens !== "number"
    )
      return null;
    return {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens,
      reasoningOutputTokens,
    };
  };
  const total = breakdown(usage.total);
  const last = breakdown(usage.last);
  if (
    !total ||
    !last ||
    (usage.modelContextWindow !== null &&
      typeof usage.modelContextWindow !== "number")
  )
    return null;
  return { total, last, modelContextWindow: usage.modelContextWindow };
}

export function codexInput(
  input: Pick<ProviderTurnInput, "text" | "attachments">,
  workspaceRoot: string,
): unknown[] {
  return [
    { type: "text", text: input.text, text_elements: [] },
    ...input.attachments.map((attachment) => {
      const resolved = resolveAttachmentPath(workspaceRoot, attachment.path);
      if (attachment.kind === "image" || attachment.kind === "audio")
        return {
          type: attachment.kind === "image" ? "localImage" : "localAudio",
          path: resolved,
        };
      return {
        type: attachment.kind === "skill" ? "skill" : "mention",
        name: attachment.name,
        path: resolved,
      };
    }),
  ];
}

export function reviewTarget(target: AgentReviewTarget) {
  switch (target.type) {
    case "uncommittedChanges":
      return { type: target.type };
    case "baseBranch":
      return { type: target.type, branch: target.branch };
    case "commit":
      return {
        type: target.type,
        sha: target.sha,
        title: target.title ?? null,
      };
    case "custom":
      return { type: target.type, instructions: target.instructions };
    default:
      throw new Error("Unsupported Codex review target");
  }
}

export function codexWarning(
  method: string,
  params: Record<string, unknown>,
): string | null {
  if (method === "warning") return stringOrNull(params.message);
  if (method === "configWarning" || method === "deprecationNotice") {
    const summary = stringOrNull(params.summary);
    return summary === null
      ? null
      : [summary, stringOrNull(params.details)].filter(Boolean).join("\n");
  }
  return null;
}
