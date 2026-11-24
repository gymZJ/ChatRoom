import type { LogWriter } from "#core/logging/types";
import type { AgentProvider } from "../provider.js";
import { ClaudeCodeProvider } from "./claude/provider.js";
import { CodexProvider } from "./codex/provider.js";
import type { AgentMcpConnection } from "../mcp-gateway.js";

export function createAgentProviders(
  logs: LogWriter,
  mcpConnection: AgentMcpConnection,
): AgentProvider[] {
  return [
    new CodexProvider(logs, mcpConnection),
    new ClaudeCodeProvider(logs, mcpConnection),
  ];
}
