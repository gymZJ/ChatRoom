import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { LogWriter } from "#core/logging/types";
import type { AgentMcpConnection } from "#plugins/agent/mcp-gateway";
import { CommandRunner } from "#core/runtime/command-runner";
import { AsyncQueue } from "#plugins/agent/async-queue";
import type {
  AgentProvider,
  AgentProviderContext,
  ProviderEvent,
  ProviderItem,
  ProviderSession,
  ProviderTurnInput,
} from "#plugins/agent/provider";
import type {
  AgentError,
  AgentInteractionOption,
  AgentInteractionResponse,
  AgentModel,
  AgentProviderDetails,
  AgentProviderProbe,
  AgentSessionConfig,
  ClaudePermissionMode,
  TokenUsageBreakdown,
} from "#plugins/agent/types";
import {
  array,
  continuityInstructions,
  errorMessage,
  isMissingExecutable,
  providerError,
  record,
  workspaceInstructions,
} from "../common.js";
import { resolveClaudeLaunch } from "./launch.js";
import {
  addUsage,
  claudeAccountUsage,
  claudeModels,
  claudeQuestions,
  claudeSessionChoices,
  claudeToolItem,
  claudeToolResultItem,
  claudeUsage,
  claudeUserContent,
  claudeVersion,
  contextWindow,
  emptyUsage,
  permissionDescription,
  permissionTitle,
  stringOrNull,
  thinkingDisplay,
  todoSteps,
} from "./mapping.js";
import {
  CLAUDE_MCP_SERVER_NAME,
  ClaudeProcess,
  claudeEnvironment,
  type ClaudeControlRequest,
  type ClaudeMessage,
} from "./process.js";

type SessionConfig = AgentSessionConfig;
type ApprovalChoice = AgentInteractionOption & { result: unknown };

const CLAUDE_PERMISSION_MODES: readonly ClaudePermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
];

const MODEL_CACHE_MS = 5 * 60_000;
const UTILITY_IDLE_MS = 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const INTERRUPT_GRACE_MS = 10_000;

export function claudePermissionMode(
  value: SessionConfig["permissionMode"],
): ClaudePermissionMode {
  if (value === null) return "default";
  const mode = CLAUDE_PERMISSION_MODES.find((candidate) => candidate === value);
  if (!mode)
    throw new Error("Unsupported Claude Code permission mode: " + value);
  return mode;
}

export class ClaudeCodeProvider implements AgentProvider {
  readonly id = "claude";
  readonly displayName = "Claude Code";
  readonly icon = "claude";
  readonly features = { nativeReview: false, steering: true } as const;
  readonly nativeSettings = [
    {
      id: "permissionMode",
      defaultValue: "default",
      options: [
        {
          id: "default",
          description:
            "Ask for approval before file edits, commands and other sensitive tools.",
        },
        {
          id: "acceptEdits",
          description:
            "Automatically accept file edits; other sensitive tools still ask.",
        },
        {
          id: "plan",
          description:
            "Plan mode: explore and propose a plan without changing files.",
        },
        {
          id: "auto",
          description:
            "Let a Claude Code classifier approve or deny permission prompts.",
        },
        {
          id: "dontAsk",
          description:
            "Never ask; anything not pre-approved by permission rules is denied.",
        },
        {
          id: "bypassPermissions",
          description:
            "Bypass all permission checks; tools can change anything the user can.",
        },
      ],
      granularFields: [],
    },
  ] as const;

  private readonly sessions = new Set<ClaudeSession>();
  private models: { value: AgentModel[]; expiresAt: number } | null = null;
  private utility: ClaudeProcess | null = null;
  private utilityStarting: Promise<ClaudeProcess> | null = null;
  private utilityInitialize: Record<string, unknown> | null = null;
  private utilityTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logs: LogWriter,
    private readonly mcpConnection: AgentMcpConnection,
    private readonly commands = new CommandRunner(),
  ) {}

  async probe(): Promise<AgentProviderProbe> {
    const launch = resolveClaudeLaunch();
    const run = (args: string[]) =>
      this.commands.run({
        command: launch.command,
        args: [...launch.args, ...args],
        env: claudeEnvironment(),
        timeoutMs: PROBE_TIMEOUT_MS,
      });
    try {
      const version = await run(["--version"]);
      let status: Record<string, unknown> | null;
      try {
        status = parseJson((await run(["auth", "status", "--json"])).stdout);
      } catch (error) {
        // `auth status` exits non-zero when logged out but still prints JSON.
        const details = record(
          error && typeof error === "object" && "details" in error
            ? (error as { details?: unknown }).details
            : null,
        );
        status = parseJson(stringOrNull(details?.stdout) ?? "");
        if (!status) throw error;
      }
      const authenticated =
        status?.loggedIn === true ||
        (typeof status?.apiProvider === "string" &&
          status.apiProvider !== "firstParty");
      return {
        installed: true,
        authenticated,
        version: claudeVersion(version.stdout),
        error: authenticated
          ? null
          : "Claude Code is not logged in. Run `claude` and complete /login.",
        capabilities: {
          namespaceTools: false,
          imageGeneration: false,
          webSearch: true,
        },
      };
    } catch (error) {
      return {
        installed: !isMissingExecutable(error),
        authenticated: false,
        version: null,
        error: errorMessage(error),
        capabilities: null,
      };
    }
  }

  async details(): Promise<AgentProviderDetails> {
    const usage = await this.withUtility((process) =>
      process.request<unknown>({ subtype: "get_usage" }),
    ).catch(() => null);
    return {
      configRequirements: null,
      rateLimits: record(usage)?.rate_limits ?? null,
      accountUsage: claudeAccountUsage(usage),
    };
  }

  async listModels(): Promise<AgentModel[]> {
    if (this.models && this.models.expiresAt > Date.now())
      return this.models.value;
    const response = await this.withUtility(async (process) =>
      process
        .request<unknown>({ subtype: "list_models" })
        .catch(() => ({ models: this.utilityInitialize?.models })),
    );
    const models = claudeModels(record(response)?.models);
    if (!models.length)
      throw new Error("Claude Code did not report any models");
    this.models = { value: models, expiresAt: Date.now() + MODEL_CACHE_MS };
    return models;
  }

  async createSession(context: AgentProviderContext): Promise<ProviderSession> {
    return this.track(
      new ClaudeSession(
        this.logs,
        this.mcpConnection,
        randomUUID(),
        context,
        false,
        (session) => this.sessions.delete(session),
      ),
    );
  }

  async resumeSession(
    context: AgentProviderContext,
    providerSessionId: string,
  ): Promise<ProviderSession> {
    return this.track(
      new ClaudeSession(
        this.logs,
        this.mcpConnection,
        providerSessionId,
        context,
        true,
        (session) => this.sessions.delete(session),
      ),
    );
  }

  async refreshMcpServers(): Promise<void> {
    await Promise.all(
      [...this.sessions].map((session) => session.reconnectMcp()),
    );
  }

  async close(): Promise<void> {
    if (this.utilityTimer) clearTimeout(this.utilityTimer);
    this.utilityTimer = null;
    const utility = this.utility;
    this.utility = null;
    await utility?.close();
  }

  private track(session: ClaudeSession): ClaudeSession {
    this.sessions.add(session);
    return session;
  }

  /**
   * Catalog and usage queries run on a short-lived helper process that has no
   * session persistence and no MCP servers; it exits after a minute idle.
   */
  private async withUtility<T>(
    action: (process: ClaudeProcess) => Promise<T>,
  ): Promise<T> {
    let process = this.utility?.alive ? this.utility : null;
    if (!process) {
      if (!this.utilityStarting)
        this.utilityStarting = this.startUtility().finally(() => {
          this.utilityStarting = null;
        });
      process = await this.utilityStarting;
    }
    if (this.utilityTimer) clearTimeout(this.utilityTimer);
    this.utilityTimer = setTimeout(() => {
      this.utilityTimer = null;
      const idle = this.utility;
      this.utility = null;
      void idle?.close();
    }, UTILITY_IDLE_MS);
    this.utilityTimer.unref();
    return action(process);
  }

  private async startUtility(): Promise<ClaudeProcess> {
    const process: ClaudeProcess = new ClaudeProcess(this.logs, {
      cwd: homedir(),
      args: ["--no-session-persistence", "--strict-mcp-config"],
      mcpConnection: null,
      onMessage: () => undefined,
      onControlRequest: ({ requestId }) =>
        process.respondError(requestId, "ChatRoom catalog process"),
      onControlCancel: () => undefined,
      onExit: () => {
        if (this.utility === process) this.utility = null;
      },
    });
    this.utilityInitialize = await process.start();
    this.utility = process;
    return process;
  }
}

type PendingInteraction =
  | {
      requestId: string;
      kind: "input";
      input: Record<string, unknown>;
      texts: Map<string, string>;
    }
  | { requestId: string; kind: "approval"; choices: Map<string, unknown> };

interface StreamBlock {
  id: string;
  kind: "text" | "thinking";
  started: boolean;
  completed: boolean;
}

class ClaudeSession implements ProviderSession {
  private config: SessionConfig;
  private process: ClaudeProcess | null = null;
  private applied: SessionConfig | null = null;
  private appliedSchema: string | null = null;
  private needsRestart = false;
  private pendingContext: string | null;
  private readonly workspaceRoot: string;
  private readonly workspacePrompt: string | null;
  private queue: AsyncQueue<ProviderEvent> | null = null;
  private turnId: string | null = null;
  private interruptRequested = false;
  private interruptTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly pendingInteractions = new Map<string, PendingInteraction>();
  private readonly streamBlocks = new Map<string, StreamBlock[]>();
  private readonly streamIndex = new Map<string, StreamBlock>();
  private streamMessageId: string | null = null;
  private readonly tools = new Map<
    string,
    { name: string; item: ProviderItem | null }
  >();
  private plan: {
    id: string;
    item: Extract<ProviderItem, { type: "plan" }>;
  } | null = null;
  private compactionId: string | null = null;
  private lastUsage: TokenUsageBreakdown | null = null;
  private totalUsage: TokenUsageBreakdown = emptyUsage();
  private modelContextWindow: number | null = null;
  private sequence = 0;

  constructor(
    private readonly logs: LogWriter,
    private readonly mcpConnection: AgentMcpConnection,
    readonly providerSessionId: string,
    context: AgentProviderContext,
    private conversationStarted: boolean,
    private readonly onClose: (session: ClaudeSession) => void,
  ) {
    this.workspaceRoot = context.workspaceRoot;
    this.workspacePrompt = context.workspacePrompt;
    this.pendingContext = context.continuityDelta;
    claudePermissionMode(context.permissionMode);
    this.config = {
      model: context.model,
      reasoningEffort: context.reasoningEffort,
      reasoningSummary: context.reasoningSummary,
      serviceTier: context.serviceTier,
      approvalPolicy: context.approvalPolicy,
      approvalsReviewer: context.approvalsReviewer,
      permissionMode: context.permissionMode,
    };
  }

  runTurn(input: ProviderTurnInput): AsyncIterable<ProviderEvent> {
    if (this.queue)
      throw new Error("Claude Code session already has an active turn");
    const queue = new AsyncQueue<ProviderEvent>();
    this.queue = queue;
    void this.startTurn(input, queue);
    return queue;
  }

  async steer(
    input: Pick<ProviderTurnInput, "text" | "attachments">,
  ): Promise<void> {
    const process = this.process;
    if (!this.queue || !this.turnId || !process?.alive)
      throw new Error("Claude Code session has no active turn to steer");
    process.send({
      type: "user",
      message: {
        role: "user",
        content: await claudeUserContent(input, this.workspaceRoot, null),
      },
      parent_tool_use_id: null,
      session_id: this.providerSessionId,
      uuid: randomUUID(),
      // Delivered at the next tool boundary of the running turn.
      priority: "next",
    });
  }

  async interrupt(): Promise<void> {
    const process = this.process;
    const queue = this.queue;
    if (!queue || !process?.alive) return;
    this.interruptRequested = true;
    await process.request({ subtype: "interrupt" }, 5_000);
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.queue === queue) this.finishTurn(queue, "interrupted", null);
    }, INTERRUPT_GRACE_MS);
    this.interruptTimer.unref();
  }

  async configure(config: SessionConfig): Promise<void> {
    claudePermissionMode(config.permissionMode);
    if (
      this.applied &&
      config.reasoningEffort === null &&
      this.applied.reasoningEffort !== null
    )
      this.needsRestart = true;
    this.config = { ...config };
  }

  async resolveInteraction(
    interactionId: string,
    response: AgentInteractionResponse,
  ): Promise<void> {
    const pending = this.pendingInteractions.get(interactionId);
    if (!pending)
      throw new Error("Unknown Claude Code interaction: " + interactionId);
    const process = this.process;
    if (!process?.alive) throw new Error("Claude Code is not running");
    if (pending.kind === "input") {
      if (response.type !== "input")
        throw new Error("Claude Code interaction requires input answers");
      const answers: Record<string, string> = {};
      for (const [id, values] of Object.entries(response.answers)) {
        const question = pending.texts.get(id);
        const answer = values.filter(Boolean).join(", ");
        if (question && answer) answers[question] = answer;
      }
      process.respond(pending.requestId, {
        behavior: "allow",
        updatedInput: { ...pending.input, answers },
      });
    } else {
      if (response.type !== "approval")
        throw new Error(
          "Claude Code interaction requires an approval decision",
        );
      if (!pending.choices.has(response.decision))
        throw new Error(
          "Unknown Claude Code approval option: " + response.decision,
        );
      const result = pending.choices.get(response.decision);
      if (record(result)?.interrupt === true) this.interruptRequested = true;
      process.respond(pending.requestId, result);
    }
    this.pendingInteractions.delete(interactionId);
  }

  async reconnectMcp(): Promise<void> {
    const process = this.process;
    if (!process?.alive) return;
    await process
      .request({ subtype: "mcp_reconnect", serverName: CLAUDE_MCP_SERVER_NAME })
      .catch((error: unknown) =>
        this.logs.warn(
          "agent.claude",
          "claude.mcp_reconnect",
          errorMessage(error),
          { sessionId: this.providerSessionId },
        ),
      );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
    const queue = this.queue;
    if (queue) this.finishTurn(queue, "interrupted", null);
    const process = this.process;
    this.process = null;
    await process?.close();
  }

  private async startTurn(
    input: ProviderTurnInput,
    queue: AsyncQueue<ProviderEvent>,
  ): Promise<void> {
    try {
      const process = await this.ensureProcess(input.outputSchema);
      await this.applyConfig(process);
      if (this.queue !== queue) return;
      const content = await claudeUserContent(
        input,
        this.workspaceRoot,
        this.pendingContext
          ? continuityInstructions(this.pendingContext)
          : null,
      );
      const uuid = randomUUID();
      this.resetTurnState();
      this.turnId = uuid;
      process.send({
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: this.providerSessionId,
        uuid,
      });
      this.pendingContext = null;
      this.conversationStarted = true;
      queue.push({ type: "turn.started", providerTurnId: uuid });
    } catch (error) {
      if (this.queue === queue)
        this.finishTurn(queue, "failed", providerError(error));
    }
  }

  private async ensureProcess(outputSchema: unknown): Promise<ClaudeProcess> {
    const schema =
      outputSchema === null || outputSchema === undefined
        ? null
        : JSON.stringify(outputSchema);
    if (
      this.process?.alive &&
      !this.needsRestart &&
      schema === this.appliedSchema
    )
      return this.process;
    const previous = this.process;
    this.process = null;
    await previous?.close();
    try {
      return await this.launch(schema, this.conversationStarted);
    } catch (error) {
      // A session created but never prompted has no transcript to resume.
      if (
        !this.conversationStarted ||
        !/No conversation found/i.test(errorMessage(error))
      )
        throw error;
      this.conversationStarted = false;
      return this.launch(schema, false);
    }
  }

  private async launch(
    schema: string | null,
    resume: boolean,
  ): Promise<ClaudeProcess> {
    const config = { ...this.config };
    const display = thinkingDisplay(config.reasoningSummary);
    let ready = false;
    const process: ClaudeProcess = new ClaudeProcess(this.logs, {
      cwd: this.workspaceRoot,
      mcpConnection: this.mcpConnection,
      args: [
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        claudePermissionMode(config.permissionMode),
        ...(config.model ? ["--model", config.model] : []),
        ...(config.reasoningEffort ? ["--effort", config.reasoningEffort] : []),
        ...(display ? ["--thinking-display", display] : []),
        ...(this.workspacePrompt
          ? [
              "--append-system-prompt",
              workspaceInstructions(this.workspacePrompt),
            ]
          : []),
        ...(schema ? ["--json-schema", schema] : []),
        ...(resume
          ? ["--resume", this.providerSessionId]
          : ["--session-id", this.providerSessionId]),
      ],
      onMessage: (message) => {
        if (ready && this.process === process) this.onMessage(message);
      },
      onControlRequest: (request) => {
        if (this.process === process) this.onControlRequest(process, request);
        else process.respondError(request.requestId, "Session replaced");
      },
      onControlCancel: (requestId) => {
        if (this.process === process) this.onControlCancel(requestId);
      },
      onExit: (error) => {
        if (this.process !== process) return;
        this.process = null;
        if (ready) this.onTransportClose(error);
      },
    });
    this.process = process;
    try {
      await process.start();
    } catch (error) {
      if (this.process === process) this.process = null;
      throw error;
    }
    ready = true;
    this.applied = config;
    this.appliedSchema = schema;
    this.needsRestart = false;
    return process;
  }

  private async applyConfig(process: ClaudeProcess): Promise<void> {
    const desired = { ...this.config };
    const applied = this.applied ?? desired;
    if (desired.model !== applied.model)
      await process.request({
        subtype: "set_model",
        ...(desired.model ? { model: desired.model } : {}),
      });
    if (desired.permissionMode !== applied.permissionMode)
      await process.request({
        subtype: "set_permission_mode",
        mode: claudePermissionMode(desired.permissionMode),
      });
    if (
      desired.reasoningEffort !== applied.reasoningEffort &&
      desired.reasoningEffort !== null
    )
      await process.request({
        subtype: "apply_flag_settings",
        settings: { effortLevel: desired.reasoningEffort },
      });
    if (desired.reasoningSummary !== applied.reasoningSummary)
      await process.request({
        subtype: "set_max_thinking_tokens",
        thinking_display: thinkingDisplay(desired.reasoningSummary),
      });
    this.applied = desired;
  }

  private onTransportClose(error: Error): void {
    const queue = this.queue;
    if (queue) this.finishTurn(queue, "failed", providerError(error));
  }

  private resetTurnState(): void {
    this.interruptRequested = false;
    this.streamBlocks.clear();
    this.streamIndex.clear();
    this.streamMessageId = null;
    this.tools.clear();
    this.plan = null;
    this.compactionId = null;
    this.lastUsage = null;
  }

  private finishTurn(
    queue: AsyncQueue<ProviderEvent>,
    status: "completed" | "interrupted" | "failed",
    error: AgentError | null,
  ): void {
    if (this.plan) {
      queue.push({
        type: "item.completed",
        providerItemId: this.plan.id,
        item: this.plan.item,
      });
      this.plan = null;
    }
    queue.push({ type: "turn.completed", status, error });
    queue.close();
    if (this.queue === queue) {
      this.queue = null;
      this.turnId = null;
    }
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = null;
    this.interruptRequested = false;
    this.pendingInteractions.clear();
    this.tools.clear();
  }

  private nextId(prefix: string): string {
    return prefix + ":" + (this.turnId ?? "idle") + ":" + ++this.sequence;
  }

  private onMessage(message: ClaudeMessage): void {
    const queue = this.queue;
    if (!queue) return;
    // Subagent traffic is summarized by the parent Task/Agent tool item.
    if (
      typeof message.parent_tool_use_id === "string" &&
      message.type !== "result"
    )
      return;
    switch (message.type) {
      case "system":
        this.onSystem(queue, message);
        return;
      case "stream_event":
        this.onStreamEvent(queue, record(message.event));
        return;
      case "assistant":
        this.onAssistant(queue, message);
        return;
      case "user":
        this.onToolResults(queue, message);
        return;
      case "tool_progress":
        this.onToolProgress(queue, message);
        return;
      case "result":
        this.onResult(queue, message);
        return;
    }
  }

  private onSystem(
    queue: AsyncQueue<ProviderEvent>,
    message: ClaudeMessage,
  ): void {
    if (message.subtype === "status") {
      if (message.status === "compacting" && !this.compactionId) {
        this.compactionId = this.nextId("compaction");
        queue.push({
          type: "item.started",
          providerItemId: this.compactionId,
          item: { type: "context_compaction", trigger: null, error: null },
        });
      }
      return;
    }
    if (message.subtype === "compact_boundary") {
      const metadata = record(message.compact_metadata);
      const trigger =
        metadata?.trigger === "auto" || metadata?.trigger === "manual"
          ? metadata.trigger
          : null;
      queue.push({
        type: "item.completed",
        providerItemId: this.compactionId ?? this.nextId("compaction"),
        item: { type: "context_compaction", trigger, error: null },
      });
      this.compactionId = null;
      return;
    }
    if (message.subtype === "api_retry") {
      const attempt = typeof message.attempt === "number" ? message.attempt : 0;
      const max =
        typeof message.max_retries === "number" ? message.max_retries : 0;
      const status =
        typeof message.error_status === "number"
          ? " (HTTP " + message.error_status + ")"
          : "";
      this.emitNotice(
        queue,
        "warning",
        `Claude API request failed${status}; retrying (${attempt}/${max})…`,
      );
    }
  }

  private onStreamEvent(
    queue: AsyncQueue<ProviderEvent>,
    event: Record<string, unknown> | null,
  ): void {
    if (!event) return;
    if (event.type === "message_start") {
      this.streamMessageId = stringOrNull(record(event.message)?.id);
      return;
    }
    const messageId = this.streamMessageId;
    if (!messageId || typeof event.index !== "number") return;
    const key = messageId + ":" + event.index;
    if (event.type === "content_block_start") {
      const type = record(event.content_block)?.type;
      if (type !== "text" && type !== "thinking") return;
      const block: StreamBlock = {
        id: "block:" + key,
        kind: type,
        started: false,
        completed: false,
      };
      this.streamIndex.set(key, block);
      const blocks = this.streamBlocks.get(messageId) ?? [];
      blocks.push(block);
      this.streamBlocks.set(messageId, blocks);
      return;
    }
    if (event.type !== "content_block_delta") return;
    const block = this.streamIndex.get(key);
    const delta = record(event.delta);
    if (!block || block.completed || !delta) return;
    const text =
      delta.type === "text_delta"
        ? stringOrNull(delta.text)
        : delta.type === "thinking_delta"
          ? stringOrNull(delta.thinking)
          : null;
    if (!text) return;
    if (!block.started) {
      block.started = true;
      queue.push({
        type: "item.started",
        providerItemId: block.id,
        item:
          block.kind === "text"
            ? { type: "assistant_message", text: "", phase: null }
            : { type: "reasoning_summary", text: "" },
      });
    }
    queue.push({
      type: "item.delta",
      providerItemId: block.id,
      field: "text",
      delta: text,
    });
  }

  private claimBlock(
    messageId: string,
    kind: StreamBlock["kind"],
  ): StreamBlock {
    const block = this.streamBlocks
      .get(messageId)
      ?.find((candidate) => candidate.kind === kind && !candidate.completed);
    if (block) {
      block.completed = true;
      return block;
    }
    return {
      id: this.nextId("block"),
      kind,
      started: false,
      completed: true,
    };
  }

  private onAssistant(
    queue: AsyncQueue<ProviderEvent>,
    message: ClaudeMessage,
  ): void {
    const payload = record(message.message);
    if (!payload) return;
    // Synthetic API error messages repeat the error reported by the result.
    if (message.is_api_error_message === true) return;
    const usage = claudeUsage(payload.usage);
    if (usage && usage.totalTokens > 0) this.lastUsage = usage;
    const messageId = stringOrNull(payload.id) ?? randomUUID();
    for (const value of array(payload.content)) {
      const block = record(value);
      if (!block) continue;
      if (block.type === "text" || block.type === "thinking") {
        const kind = block.type;
        const text =
          stringOrNull(kind === "text" ? block.text : block.thinking) ?? "";
        const claimed = this.claimBlock(messageId, kind);
        if (!text.trim() && !claimed.started) continue;
        queue.push({
          type: "item.completed",
          providerItemId: claimed.id,
          item:
            kind === "text"
              ? { type: "assistant_message", text, phase: null }
              : { type: "reasoning_summary", text },
        });
        continue;
      }
      if (block.type === "tool_use") this.onToolUse(queue, block);
    }
  }

  private onToolUse(
    queue: AsyncQueue<ProviderEvent>,
    block: Record<string, unknown>,
  ): void {
    const id = stringOrNull(block.id);
    const name = stringOrNull(block.name);
    if (!id || !name || this.tools.has(id)) return;
    const input = record(block.input) ?? {};
    if (name === "AskUserQuestion") {
      // Shown as an input interaction instead of a tool item.
      this.tools.set(id, { name, item: null });
      return;
    }
    if (name === "TodoWrite") {
      const item: Extract<ProviderItem, { type: "plan" }> = {
        type: "plan",
        text: "",
        steps: todoSteps(input),
      };
      const planId = this.plan?.id ?? this.nextId("plan");
      queue.push({
        type: this.plan ? "item.updated" : "item.started",
        providerItemId: planId,
        item,
      });
      this.plan = { id: planId, item };
      this.tools.set(id, { name, item: null });
      return;
    }
    const item = claudeToolItem(name, input, this.workspaceRoot);
    this.tools.set(id, { name, item });
    queue.push({ type: "item.started", providerItemId: id, item });
  }

  private onToolResults(
    queue: AsyncQueue<ProviderEvent>,
    message: ClaudeMessage,
  ): void {
    const results = array(record(message.message)?.content)
      .map(record)
      .filter(
        (block): block is Record<string, unknown> =>
          block?.type === "tool_result",
      );
    for (const result of results) {
      const id = stringOrNull(result.tool_use_id);
      const tool = id ? this.tools.get(id) : undefined;
      if (!id || !tool) continue;
      this.tools.delete(id);
      if (!tool.item) continue;
      const failed = result.is_error === true;
      queue.push({
        type: "item.completed",
        providerItemId: id,
        item: claudeToolResultItem(
          tool.item,
          tool.name,
          result.content,
          failed,
          results.length === 1 ? message.tool_use_result : null,
          this.workspaceRoot,
        ),
        failed,
      });
    }
  }

  private onToolProgress(
    queue: AsyncQueue<ProviderEvent>,
    message: ClaudeMessage,
  ): void {
    const id = stringOrNull(message.tool_use_id);
    const tool = id ? this.tools.get(id) : undefined;
    if (!id || tool?.item?.type !== "tool") return;
    const seconds =
      typeof message.elapsed_time_seconds === "number"
        ? message.elapsed_time_seconds
        : null;
    const item = {
      ...tool.item,
      progress: seconds === null ? "Running…" : `Running… ${seconds}s`,
    };
    tool.item = item;
    queue.push({ type: "item.updated", providerItemId: id, item });
  }

  private onResult(
    queue: AsyncQueue<ProviderEvent>,
    message: ClaudeMessage,
  ): void {
    if (typeof message.parent_tool_use_id === "string") return;
    const usage = claudeUsage(message.usage);
    if (usage) this.totalUsage = addUsage(this.totalUsage, usage);
    this.modelContextWindow =
      contextWindow(message.modelUsage) ?? this.modelContextWindow;
    if (this.totalUsage.totalTokens > 0)
      queue.push({
        type: "token.usage",
        usage: {
          total: this.totalUsage,
          last: this.lastUsage ?? usage ?? emptyUsage(),
          modelContextWindow: this.modelContextWindow,
        },
      });
    if (
      message.structured_output !== undefined &&
      message.structured_output !== null
    )
      queue.push({
        type: "item.completed",
        providerItemId: this.nextId("structured"),
        item: {
          type: "assistant_message",
          text: JSON.stringify(message.structured_output, null, 2),
          phase: "final_answer",
        },
      });
    // Steering messages that were not absorbed mid-turn run as queued turns;
    // keep the ChatRoom turn open until the queue drains.
    if (
      !this.interruptRequested &&
      typeof message.queued_turn_count === "number" &&
      message.queued_turn_count > 0
    )
      return;
    const failed = message.is_error === true || message.subtype !== "success";
    if (this.interruptRequested) {
      this.finishTurn(queue, "interrupted", null);
      return;
    }
    if (!failed) {
      this.finishTurn(queue, "completed", null);
      return;
    }
    const errors = array(message.errors).filter(
      (error): error is string => typeof error === "string",
    );
    this.finishTurn(queue, "failed", {
      message:
        stringOrNull(message.result) ||
        errors[0] ||
        "Claude Code turn failed (" + String(message.subtype) + ")",
      details: errors.length ? errors.join("\n") : null,
      providerData: {
        subtype: message.subtype ?? null,
        terminalReason: message.terminal_reason ?? null,
        apiErrorStatus: message.api_error_status ?? null,
      },
    });
  }

  private emitNotice(
    queue: AsyncQueue<ProviderEvent>,
    level: "warning" | "error",
    text: string,
  ): void {
    queue.push({
      type: "item.completed",
      providerItemId: this.nextId("notice"),
      item: { type: "notice", level, text },
    });
  }

  private onControlCancel(requestId: string): void {
    if (!this.pendingInteractions.delete(requestId)) return;
    this.queue?.push({
      type: "interaction.resolved",
      providerRequestId: requestId,
    });
  }

  private onControlRequest(
    process: ClaudeProcess,
    { requestId, request }: ClaudeControlRequest,
  ): void {
    if (request.subtype !== "can_use_tool") {
      process.respondError(
        requestId,
        "ChatRoom does not support Claude Code control request " +
          request.subtype,
      );
      return;
    }
    const queue = this.queue;
    if (!queue) {
      process.respond(requestId, {
        behavior: "deny",
        message: "No active ChatRoom turn",
      });
      return;
    }
    const toolName = stringOrNull(request.tool_name) ?? "tool";
    const input = record(request.input) ?? {};

    if (toolName === "AskUserQuestion") {
      const { questions, texts } = claudeQuestions(input);
      this.pendingInteractions.set(requestId, {
        requestId,
        kind: "input",
        input,
        texts,
      });
      queue.push({
        type: "interaction.requested",
        providerItemId: "interaction:" + requestId,
        interaction: {
          id: requestId,
          kind: "input",
          title: stringOrNull(input.title) ?? "Input required",
          description: null,
          questions,
          approvalOptions: [],
        },
      });
      return;
    }

    const allow = (updatedPermissions?: unknown[]) => ({
      behavior: "allow",
      updatedInput: input,
      ...(updatedPermissions?.length ? { updatedPermissions } : {}),
    });
    const deny = (message: string, interrupt = false) => ({
      behavior: "deny",
      message,
      ...(interrupt ? { interrupt: true } : {}),
    });

    if (toolName === "ExitPlanMode") {
      this.requestApproval(
        queue,
        requestId,
        "Approve plan",
        stringOrNull(input.plan),
        [
          {
            id: "acceptEdits",
            label: "Approve and auto-accept edits",
            description: null,
            result: allow([
              { type: "setMode", mode: "acceptEdits", destination: "session" },
            ]),
          },
          {
            id: "accept",
            label: "Approve and review edits",
            description: null,
            result: allow([
              { type: "setMode", mode: "default", destination: "session" },
            ]),
          },
          {
            id: "decline",
            label: "Keep planning",
            description: null,
            result: deny("The user wants to keep planning."),
          },
        ],
      );
      return;
    }

    const choices: ApprovalChoice[] = [
      { id: "accept", label: "Allow once", description: null, result: allow() },
      ...claudeSessionChoices(
        toolName,
        array(request.permission_suggestions),
      ).map(({ updatedPermissions, ...choice }) => ({
        ...choice,
        result: allow(updatedPermissions),
      })),
    ];
    choices.push(
      {
        id: "decline",
        label: "Deny",
        description: null,
        result: deny("The user denied this operation."),
      },
      {
        id: "cancel",
        label: "Cancel turn",
        description: null,
        result: deny(
          "The user denied this operation and stopped the turn.",
          true,
        ),
      },
    );
    this.requestApproval(
      queue,
      requestId,
      permissionTitle(toolName, request),
      permissionDescription(toolName, input, request, this.workspaceRoot),
      choices,
    );
  }

  private requestApproval(
    queue: AsyncQueue<ProviderEvent>,
    requestId: string,
    title: string,
    description: string | null,
    choices: ApprovalChoice[],
  ): void {
    this.pendingInteractions.set(requestId, {
      requestId,
      kind: "approval",
      choices: new Map(choices.map((choice) => [choice.id, choice.result])),
    });
    queue.push({
      type: "interaction.requested",
      providerItemId: "interaction:" + requestId,
      interaction: {
        id: requestId,
        kind: "approval",
        title,
        description,
        questions: [],
        approvalOptions: choices.map(({ id, label, description }) => ({
          id,
          label,
          description,
        })),
      },
    });
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}
