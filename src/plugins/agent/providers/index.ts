import type { LogWriter } from "#core/logging/types";
import type { AgentProvider } from "../provider.js";
import { CodexProvider } from "./codex/provider.js";

export function createAgentProviders(logs: LogWriter): AgentProvider[] {
  return [new CodexProvider(logs)];
}
