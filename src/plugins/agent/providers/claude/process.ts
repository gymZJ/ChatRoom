import type { LogWriter } from "#core/logging/types";
import { LineProcess } from "#core/runtime/line-process";
import { resolveClaudeLaunch } from "./launch.js";

export type ClaudeMessage = Record<string, unknown> & { type: string };

export interface ClaudeControlRequest {
  requestId: string;
  request: Record<string, unknown> & { subtype: string };
}

export interface ClaudeMcpConnection {
  url: string;
  token: string;
}

export interface ClaudeProcessOptions {
  cwd: string;
  args: string[];
  mcpConnection: ClaudeMcpConnection | null;
  onMessage(message: ClaudeMessage): void;
  onControlRequest(request: ClaudeControlRequest): void;
  onControlCancel(requestId: string): void;
  onExit(error: Error): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 60_000;
const MCP_SERVER_NAME = "chatroom_agent";
const MCP_TOKEN_ENV = "CHATROOM_AGENT_MCP_TOKEN";

// Environment that configures Claude Code authentication, API routing and
// third-party providers. ChatRoom otherwise starts children with a minimal
// environment, so these must be forwarded explicitly.
const CLAUDE_ENV_PREFIXES = [
  "ANTHROPIC_",
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_SKIP_",
  "AWS_",
  "VERTEX_REGION_",
];
const CLAUDE_ENV_KEYS = new Set([
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
]);

export function claudeEnvironment(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      CLAUDE_ENV_KEYS.has(key) ||
      CLAUDE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    )
      env[key] = value;
  }
  // AskUserQuestion is disabled in headless mode unless the host opts in.
  env.CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL = "1";
  return { ...env, ...extra };
}

export function claudeMcpConfig(connection: ClaudeMcpConnection): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "http",
        url: connection.url,
        // Claude Code expands ${VAR} in MCP configuration, which keeps the
        // token out of the process arguments.
        headers: { Authorization: "Bearer ${" + MCP_TOKEN_ENV + "}" },
      },
    },
  });
}

export const CLAUDE_MCP_SERVER_NAME = MCP_SERVER_NAME;

/**
 * One Claude Code CLI process speaking the stream-json control protocol
 * (`claude -p --input-format stream-json --output-format stream-json`).
 */
export class ClaudeProcess {
  private process: LineProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 1;
  private exited = false;
  private readonly stderrTail: string[] = [];
  private ready = false;
  private startupError: string | null = null;

  constructor(
    private readonly logs: LogWriter,
    private readonly options: ClaudeProcessOptions,
  ) {}

  async start(): Promise<Record<string, unknown>> {
    const launch = resolveClaudeLaunch();
    const args = [
      ...launch.args,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(this.options.mcpConnection
        ? ["--mcp-config", claudeMcpConfig(this.options.mcpConnection)]
        : []),
      ...this.options.args,
    ];
    const process: LineProcess = new LineProcess({
      command: launch.command,
      args,
      cwd: this.options.cwd,
      env: claudeEnvironment(
        this.options.mcpConnection
          ? { [MCP_TOKEN_ENV]: this.options.mcpConnection.token }
          : {},
      ),
      onStdout: (line) => this.handleLine(line),
      onStderr: (line) => {
        const message = line.trim();
        if (!message) return;
        this.stderrTail.push(message.slice(0, 1000));
        if (this.stderrTail.length > 20) this.stderrTail.shift();
        this.logs.debug(
          "agent.claude",
          "claude.stderr",
          message.slice(0, 4000),
        );
      },
      onExit: (code, signal) => {
        if (this.process !== process) return;
        // Let trailing stdout/stderr lines drain so the failure says why.
        const timer = setTimeout(() => {
          const detail = this.startupError ?? this.stderrTail.at(-1);
          this.fail(
            new Error(
              "Claude Code exited" +
                (code === null ? "" : " with code " + code) +
                (signal ? " (" + signal + ")" : "") +
                (detail ? ": " + detail : ""),
            ),
          );
        }, 50);
        timer.unref();
      },
      onError: (error) => {
        if (this.process === process) this.fail(error);
      },
    });
    this.process = process;
    try {
      await process.spawned();
      const initialized = await this.request<Record<string, unknown>>(
        { subtype: "initialize" },
        INITIALIZE_TIMEOUT_MS,
      );
      this.ready = true;
      return initialized;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      process.terminate();
      await process.waitForExit(500);
      process.forceKill();
      throw failure;
    }
  }

  get alive(): boolean {
    return this.process !== null && !this.exited;
  }

  request<T>(
    request: Record<string, unknown> & { subtype: string },
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const requestId = "chatroom-" + this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(
          new Error(
            "Claude Code control request timed out: " + request.subtype,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ type: "control_request", request_id: requestId, request });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  respond(requestId: string, response: unknown): void {
    this.send({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
  }

  respondError(requestId: string, error: string): void {
    this.send({
      type: "control_response",
      response: { subtype: "error", request_id: requestId, error },
    });
  }

  send(message: Record<string, unknown>): void {
    if (!this.process || this.exited)
      throw new Error("Claude Code is not running");
    this.process.writeLine(JSON.stringify(message));
  }

  async close(): Promise<void> {
    const process = this.process;
    if (!process) return;
    this.fail(new Error("Claude Code closed"));
    process.terminate();
    await process.waitForExit(1500);
    process.forceKill();
  }

  private fail(error: Error): void {
    if (this.exited) return;
    this.exited = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.options.onExit(error);
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.logs.warn(
        "agent.claude",
        "claude.invalid_json",
        "Claude Code emitted invalid JSON",
        { line: line.slice(0, 1000) },
      );
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") return;

    if (message.type === "control_response") {
      const response = isRecord(message.response) ? message.response : null;
      const requestId =
        typeof response?.request_id === "string" ? response.request_id : null;
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (!response || !requestId || !pending) return;
      this.pending.delete(requestId);
      if (response.subtype === "error")
        pending.reject(
          new Error(
            typeof response.error === "string"
              ? response.error
              : "Claude Code control request failed",
          ),
        );
      else pending.resolve(response.response ?? null);
      return;
    }

    if (message.type === "control_request") {
      if (
        typeof message.request_id !== "string" ||
        !isRecord(message.request) ||
        typeof message.request.subtype !== "string"
      )
        return;
      this.options.onControlRequest({
        requestId: message.request_id,
        request: message.request as ClaudeControlRequest["request"],
      });
      return;
    }

    if (message.type === "control_cancel_request") {
      if (typeof message.request_id === "string")
        this.options.onControlCancel(message.request_id);
      return;
    }

    if (!this.ready && message.type === "result" && message.is_error === true)
      this.startupError =
        [
          ...(Array.isArray(message.errors) ? message.errors : []),
          message.result,
        ]
          .filter((part): part is string => typeof part === "string" && !!part)
          .join("\n") || null;
    this.options.onMessage(message as ClaudeMessage);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
