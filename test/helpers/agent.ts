import type { LogWriter } from "../../src/core/logging/types.js";
import type { AgentMcpConnection } from "../../src/plugins/agent/mcp-gateway.js";

export const silentLogs: LogWriter = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Points providers at an address nothing listens on. */
export const unusedMcpConnection: AgentMcpConnection = {
  url: "http://127.0.0.1:9/mcp",
  token: "test-token",
};
