import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderItem, ProviderTurnInput } from "#plugins/agent/provider";
import type {
  AgentFileChange,
  AgentInputQuestion,
  AgentModel,
  AgentPlanStep,
  AgentProviderAccountUsage,
  AgentTokenUsage,
  TokenUsageBreakdown,
} from "#plugins/agent/types";
import {
  array,
  questionOptions,
  record,
  stringifyOptional,
} from "../common.js";

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: "Fastest responses with minimal thinking.",
  medium: "Balanced speed and reasoning depth.",
  high: "Deeper reasoning for complex tasks.",
  xhigh: "Extended reasoning for difficult tasks.",
  max: "Maximum reasoning depth.",
};

export function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function claudeModels(value: unknown): AgentModel[] {
  const entries = array(value)
    .map(record)
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry?.value === "string",
    );
  const defaultEntry = entries.find((entry) => entry.value === "default");
  const models = entries.filter((entry) => entry.value !== "default");
  const defaultModel =
    models.find(
      (entry) =>
        defaultEntry !== undefined &&
        typeof entry.resolvedModel === "string" &&
        entry.resolvedModel === defaultEntry.resolvedModel,
    ) ?? models[0];
  return models.map((entry) => {
    const efforts = array(entry.supportedEffortLevels).filter(
      (effort): effort is string => typeof effort === "string",
    );
    const thinking =
      entry.supportsAdaptiveThinking === true || entry.supportsEffort === true;
    const id = entry.value as string;
    return {
      id,
      model: stringOrNull(entry.resolvedModel) ?? id,
      displayName: stringOrNull(entry.displayName) ?? id,
      description: stringOrNull(entry.description) ?? "",
      modelSpecialty: null,
      isDefault: entry === defaultModel,
      upgrade: null,
      upgradeInfo: null,
      availabilityMessage: null,
      reasoningEfforts:
        entry.supportsEffort === true
          ? efforts.map((effort) => ({
              id: effort,
              description: EFFORT_DESCRIPTIONS[effort] ?? effort,
            }))
          : [],
      defaultReasoningEffort: null,
      reasoningSummaries: thinking ? ["auto", "none"] : [],
      defaultReasoningSummary: null,
      inputModalities: ["text", "image"],
      multiAgentVersion: null,
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
    };
  });
}

/** ChatRoom reasoning summary → Claude Code thinking display. */
export function thinkingDisplay(
  summary: AgentModel["reasoningSummaries"][number] | null,
): string | null {
  if (summary === "none") return "omitted";
  if (summary === null) return null;
  return "summarized";
}

export function claudeAccountUsage(
  value: unknown,
): AgentProviderAccountUsage | null {
  const usage = record(value);
  if (!usage) return null;
  const limits = record(usage.rate_limits);
  const subscriptionType = stringOrNull(usage.subscription_type);
  if (!limits && !subscriptionType) return null;
  const windows: AgentProviderAccountUsage["windows"] = [];
  for (const id of [
    "five_hour",
    "seven_day",
    "seven_day_oauth_apps",
    "seven_day_opus",
    "seven_day_sonnet",
  ]) {
    const window = record(limits?.[id]);
    if (!window) continue;
    windows.push({
      id,
      label: null,
      utilization:
        typeof window.utilization === "number" ? window.utilization : null,
      resetsAt: stringOrNull(window.resets_at),
    });
  }
  for (const value of array(limits?.model_scoped)) {
    const window = record(value);
    const name = stringOrNull(window?.display_name);
    if (!window || !name) continue;
    windows.push({
      id: "model:" + name,
      label: name,
      utilization:
        typeof window.utilization === "number" ? window.utilization : null,
      resetsAt: stringOrNull(window.resets_at),
    });
  }
  const extra = record(limits?.extra_usage);
  return {
    subscriptionType,
    windows,
    extraUsage: extra
      ? {
          enabled: extra.is_enabled === true,
          monthlyLimit:
            typeof extra.monthly_limit === "number"
              ? extra.monthly_limit
              : null,
          usedCredits:
            typeof extra.used_credits === "number" ? extra.used_credits : null,
          utilization:
            typeof extra.utilization === "number" ? extra.utilization : null,
          currency: stringOrNull(extra.currency),
        }
      : null,
    updatedAt: new Date().toISOString(),
  };
}

export function emptyUsage(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

/**
 * Anthropic reports uncached input separately from cache reads and writes.
 * ChatRoom follows the Codex convention where inputTokens includes cached
 * input, so the cache counters are folded into it.
 */
export function claudeUsage(value: unknown): TokenUsageBreakdown | null {
  const usage = record(value);
  if (!usage) return null;
  const number = (key: string) =>
    typeof usage[key] === "number" ? (usage[key] as number) : 0;
  const cacheRead = number("cache_read_input_tokens");
  const cacheWrite = number("cache_creation_input_tokens");
  const inputTokens = number("input_tokens") + cacheRead + cacheWrite;
  const outputTokens = number("output_tokens");
  const details = record(usage.output_tokens_details);
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens,
    reasoningOutputTokens:
      typeof details?.thinking_tokens === "number"
        ? details.thinking_tokens
        : 0,
  };
}

export function addUsage(
  left: TokenUsageBreakdown,
  right: TokenUsageBreakdown,
): TokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens:
      left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

export function contextWindow(modelUsage: unknown): number | null {
  let window: number | null = null;
  for (const value of Object.values(record(modelUsage) ?? {})) {
    const entry = record(value);
    if (typeof entry?.contextWindow === "number")
      window = Math.max(window ?? 0, entry.contextWindow);
  }
  return window;
}

export function tokenUsage(
  total: TokenUsageBreakdown,
  last: TokenUsageBreakdown,
  modelContextWindow: number | null,
): AgentTokenUsage {
  return { total, last, modelContextWindow };
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function resolveAttachmentPath(root: string, attachmentPath: string): string {
  const absolute = path.resolve(root, attachmentPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Attachment is outside the workspace");
  return absolute;
}

/** Builds the content blocks of a stream-json user message. */
export async function claudeUserContent(
  input: Pick<ProviderTurnInput, "text" | "attachments">,
  workspaceRoot: string,
  prefix: string | null,
): Promise<unknown[]> {
  const references: string[] = [];
  const images: unknown[] = [];
  for (const attachment of input.attachments) {
    const resolved = resolveAttachmentPath(workspaceRoot, attachment.path);
    const mime =
      attachment.mimeType &&
      Object.values(IMAGE_MIME).includes(attachment.mimeType)
        ? attachment.mimeType
        : IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (attachment.kind === "image" && mime) {
      images.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mime,
          data: (await readFile(resolved)).toString("base64"),
        },
      });
      continue;
    }
    references.push(
      attachment.kind === "skill"
        ? `- Skill: ${resolved} (read this SKILL.md and follow it)`
        : `- ${attachment.kind === "audio" ? "Audio file" : "File"}: ${resolved}`,
    );
  }
  const text = [
    prefix,
    input.text,
    references.length
      ? "Attached workspace files:\n" + references.join("\n")
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return [...images, { type: "text", text }];
}

export function mcpToolName(
  name: string,
): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function relativePath(value: unknown, workspaceRoot: string): string {
  if (typeof value !== "string") return "";
  const relative = path.relative(
    workspaceRoot,
    path.resolve(workspaceRoot, value),
  );
  if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return relative.split(path.sep).join("/");
}

function inputDiff(name: string, input: Record<string, unknown>): string {
  const lines = (prefix: string, value: unknown) =>
    typeof value === "string"
      ? value
          .split("\n")
          .map((line) => prefix + line)
          .join("\n")
      : "";
  if (name === "Edit")
    return [lines("-", input.old_string), lines("+", input.new_string)]
      .filter(Boolean)
      .join("\n");
  if (name === "MultiEdit")
    return array(input.edits)
      .map(record)
      .filter((edit): edit is Record<string, unknown> => Boolean(edit))
      .map((edit) =>
        [lines("-", edit.old_string), lines("+", edit.new_string)]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n@@\n");
  if (name === "Write") return lines("+", input.content);
  return "";
}

export function structuredPatchDiff(value: unknown): string {
  return array(value)
    .map(record)
    .filter((hunk): hunk is Record<string, unknown> => Boolean(hunk))
    .map((hunk) => {
      const header =
        "@@ -" +
        String(hunk.oldStart ?? 0) +
        "," +
        String(hunk.oldLines ?? 0) +
        " +" +
        String(hunk.newStart ?? 0) +
        "," +
        String(hunk.newLines ?? 0) +
        " @@";
      const lines = array(hunk.lines).filter(
        (line): line is string => typeof line === "string",
      );
      return [header, ...lines].join("\n");
    })
    .join("\n");
}

export function todoSteps(input: Record<string, unknown>): AgentPlanStep[] {
  return array(input.todos).flatMap((value) => {
    const todo = record(value);
    if (!todo || typeof todo.content !== "string") return [];
    const status: AgentPlanStep["status"] =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "inProgress"
          : "pending";
    return [{ step: todo.content, status }];
  });
}

/** Maps a tool_use block to the ChatRoom item shown while it runs. */
export function claudeToolItem(
  name: string,
  input: Record<string, unknown>,
  workspaceRoot: string,
): ProviderItem {
  if (name === "Bash")
    return {
      type: "command",
      command: stringOrNull(input.command) ?? "",
      cwd: workspaceRoot,
      output: "",
      exitCode: null,
    };
  if (FILE_TOOLS.has(name)) {
    const target = input.file_path ?? input.notebook_path;
    return {
      type: "file_change",
      changes: [
        {
          path: relativePath(target, workspaceRoot),
          kind: "update",
          movePath: null,
          diff: inputDiff(name, input),
        },
      ],
    };
  }
  if (name === "ExitPlanMode")
    return { type: "plan", text: stringOrNull(input.plan) ?? "", steps: [] };
  const mcp = mcpToolName(name);
  return {
    type: "tool",
    progress: null,
    name: mcp?.tool ?? name,
    server: mcp?.server ?? null,
    input,
    output: null,
    error: null,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return array(content)
    .map(record)
    .map((block) => (block?.type === "text" ? stringOrNull(block.text) : null))
    .filter((text): text is string => text !== null)
    .join("\n");
}

/** Maps a finished tool_use (with its tool_result) to the completed item. */
export function claudeToolResultItem(
  started: ProviderItem,
  toolName: string,
  content: unknown,
  isError: boolean,
  structured: unknown,
  workspaceRoot: string,
): ProviderItem {
  const text = toolResultText(content);
  const result = record(structured);
  if (started.type === "command") {
    const stdout = stringOrNull(result?.stdout);
    const stderr = stringOrNull(result?.stderr);
    const output =
      stdout !== null || stderr !== null
        ? [stdout, stderr].filter(Boolean).join("\n")
        : text;
    const exit = /^Exit code (\d+)/.exec(text);
    return {
      ...started,
      output,
      exitCode: exit ? Number(exit[1]) : isError ? null : 0,
    };
  }
  if (started.type === "file_change") {
    if (isError || !result) return started;
    const filePath = result.filePath ?? result.notebook_path;
    const change: AgentFileChange = {
      path: filePath
        ? relativePath(filePath, workspaceRoot)
        : (started.changes[0]?.path ?? ""),
      kind: result.type === "create" ? "add" : "update",
      movePath: null,
      diff:
        structuredPatchDiff(result.structuredPatch) ||
        started.changes[0]?.diff ||
        "",
    };
    return { type: "file_change", changes: [change] };
  }
  if (started.type === "plan") return started;
  if (started.type === "tool")
    return {
      ...started,
      progress: null,
      output: structured ?? (text || content || null),
      error: isError ? text || toolName + " failed" : null,
    };
  return started;
}

export function claudeQuestions(input: Record<string, unknown>): {
  questions: AgentInputQuestion[];
  texts: Map<string, string>;
} {
  const texts = new Map<string, string>();
  const questions = array(input.questions)
    .map(record)
    .filter((question): question is Record<string, unknown> =>
      Boolean(question),
    )
    .map((question, index) => {
      const id = "question_" + index;
      const text =
        typeof question.question === "string"
          ? question.question
          : "Provide input";
      texts.set(id, text);
      const options = questionOptions(question.options);
      return {
        id,
        label: typeof question.header === "string" ? question.header : id,
        question: text,
        options,
        multiSelect: question.multiSelect === true,
        allowFreeText: true,
        secret: false,
      };
    });
  return { questions, texts };
}

export function permissionDescription(
  toolName: string,
  input: Record<string, unknown>,
  request: Record<string, unknown>,
  workspaceRoot: string,
): string | null {
  const reason =
    stringOrNull(request.decision_reason) ?? stringOrNull(request.description);
  let subject: string | null;
  if (toolName === "Bash") subject = stringOrNull(input.command);
  else if (FILE_TOOLS.has(toolName) || toolName === "Read")
    subject = relativePath(
      input.file_path ?? input.notebook_path,
      workspaceRoot,
    );
  else if (toolName === "WebFetch") subject = stringOrNull(input.url);
  else subject = stringifyOptional(input);
  return [subject, reason].filter(Boolean).join("\n\n") || null;
}

export function permissionTitle(
  toolName: string,
  request: Record<string, unknown>,
): string {
  const title = stringOrNull(request.title);
  if (title) return title;
  if (toolName === "Bash") return "Approve command";
  if (FILE_TOOLS.has(toolName)) return "Approve file changes";
  const mcp = mcpToolName(toolName);
  const display = stringOrNull(request.display_name);
  return "Approve " + (display ?? mcp?.tool ?? toolName);
}

export function claudeVersion(output: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null;
}

export interface ClaudeSessionChoice {
  id:
    | "acceptForSession"
    | "acceptCommandForSession"
    | "acceptEditsForSession"
    | "acceptToolForSession";
  label: string;
  description: string | null;
  updatedPermissions: Record<string, unknown>[];
}

function describePermissionUpdate(update: Record<string, unknown>): string {
  if (update.type === "addRules" || update.type === "replaceRules")
    return array(update.rules)
      .map(record)
      .filter((rule): rule is Record<string, unknown> => Boolean(rule))
      .map((rule) =>
        typeof rule.ruleContent === "string" && rule.ruleContent
          ? `${String(rule.toolName)}(${rule.ruleContent})`
          : String(rule.toolName),
      )
      .join(", ");
  if (update.type === "setMode") return "mode: " + String(update.mode);
  if (update.type === "addDirectories")
    return "directories: " + array(update.directories).join(", ");
  return String(update.type);
}

function isAcceptEditsMode(update: Record<string, unknown>): boolean {
  return update.type === "setMode" && update.mode === "acceptEdits";
}

/**
 * Session-scoped approval options for a Claude Code permission prompt.
 *
 * Claude Code suggests narrow rules (for Bash, the exact command), so the
 * suggestion is offered under a label that states its scope, next to a
 * tool-wide session allow: all edits for file tools, every call otherwise.
 */
export function claudeSessionChoices(
  toolName: string,
  suggestions: unknown[],
): ClaudeSessionChoice[] {
  const updates = suggestions
    .map(record)
    .filter((update): update is Record<string, unknown> => Boolean(update))
    .map((update): Record<string, unknown> => ({
      ...update,
      destination: "session",
    }));
  const choices: ClaudeSessionChoice[] = [];
  if (updates.length) {
    const rules = updates.flatMap((update) =>
      update.type === "addRules" && update.behavior === "allow"
        ? array(update.rules).map(record)
        : [null],
    );
    const id: ClaudeSessionChoice["id"] = updates.every(isAcceptEditsMode)
      ? "acceptEditsForSession"
      : rules.length &&
          rules.every(
            (rule) => rule?.toolName === "Bash" && Boolean(rule.ruleContent),
          )
        ? "acceptCommandForSession"
        : "acceptForSession";
    choices.push({
      id,
      label:
        id === "acceptEditsForSession"
          ? "Auto-accept file edits this session"
          : id === "acceptCommandForSession"
            ? "Don't ask again for this command this session"
            : "Allow as suggested for this session",
      description: updates.map(describePermissionUpdate).join("; ") || null,
      updatedPermissions: updates,
    });
  }
  if (FILE_TOOLS.has(toolName)) {
    if (!choices.some((choice) => choice.id === "acceptEditsForSession"))
      choices.push({
        id: "acceptEditsForSession",
        label: "Auto-accept file edits this session",
        description: "mode: acceptEdits",
        updatedPermissions: [
          { type: "setMode", mode: "acceptEdits", destination: "session" },
        ],
      });
    return choices;
  }
  choices.push({
    id: "acceptToolForSession",
    label: "Allow every " + toolName + " call this session",
    description: toolName,
    updatedPermissions: [
      {
        type: "addRules",
        rules: [{ toolName }],
        behavior: "allow",
        destination: "session",
      },
    ],
  });
  return choices;
}
