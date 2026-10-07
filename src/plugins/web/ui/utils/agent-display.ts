import type {
  AgentModel,
  AgentProviderId,
  AgentProviderStatus,
} from "../api.js";
import { effectiveModelId } from "./agent-config.js";

export function agentProviderStatus(
  providers: readonly AgentProviderStatus[],
  provider: AgentProviderId,
): AgentProviderStatus | null {
  return providers.find((item) => item.id === provider) ?? null;
}

export function agentProviderName(
  providers: readonly AgentProviderStatus[],
  provider: AgentProviderId,
): string {
  return agentProviderStatus(providers, provider)?.displayName ?? provider;
}

export function agentProviderIcon(
  providers: readonly AgentProviderStatus[],
  provider: AgentProviderId,
): string | null {
  return agentProviderStatus(providers, provider)?.icon ?? null;
}

export function agentModelDisplayName(
  providerModels: Readonly<Record<AgentProviderId, AgentModel[]>>,
  provider: AgentProviderId,
  modelId: string | null,
  defaultLabel: string,
): string {
  const effective = effectiveModelId(providerModels, provider, modelId);
  if (!effective) return defaultLabel;
  return (
    (providerModels[provider] ?? []).find((model) => model.id === effective)
      ?.displayName ?? effective
  );
}

export function defaultAgentSettingLabel(
  defaultLabel: string,
  officialDefault?: string | null,
): string {
  return officialDefault
    ? `${defaultLabel} (${officialDefault})`
    : defaultLabel;
}

export function agentFileName(filePath: string): string {
  return filePath.split("/").pop() ?? filePath;
}
