import { ChatRoomError } from "#core/errors/chatroom-error";
import type { AgentProvider } from "./provider.js";
import {
  isAgentPermissionMode,
  isApprovalPolicyMode,
  isApprovalsReviewer,
  type AgentAttachment,
  type AgentProviderNativeSetting,
  type AgentSessionConfig,
  type CodexGranularApprovalPolicy,
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

type NativeSettingSource = {
  readonly id: string;
  readonly nativeSettings: readonly AgentProviderNativeSetting[];
};

function granularSupported(
  value: { granular: Record<string, unknown> },
  setting: AgentProviderNativeSetting,
): boolean {
  if (!setting.options.some((option) => option.id === "granular")) return false;
  const granular = value.granular as Record<string, unknown>;
  return (
    setting.granularFields.every(
      (field) => typeof granular[field.id] === "boolean",
    ) &&
    Object.keys(granular).every((key) =>
      setting.granularFields.some((field) => field.id === key),
    )
  );
}

function optionSupported(
  value: unknown,
  setting: AgentProviderNativeSetting,
): boolean {
  if (value !== null && typeof value === "object")
    return granularSupported(
      value as { granular: Record<string, unknown> },
      setting,
    );
  return setting.options.some((option) => option.id === value);
}

function invalid(message: string): ChatRoomError {
  return new ChatRoomError("INVALID_INPUT", message);
}

/**
 * Fills provider-native settings from the provider's declared defaults and
 * rejects values the provider does not advertise. The runtime stays
 * provider-agnostic: everything it checks comes from `nativeSettings`.
 */
export function applyNativeSettings(
  provider: NativeSettingSource,
  input: AgentSessionConfig,
): AgentSessionConfig {
  const config = { ...input };
  const setting = (id: AgentProviderNativeSetting["id"]) =>
    provider.nativeSettings.find((candidate) => candidate.id === id) ?? null;
  const check = (
    id: AgentProviderNativeSetting["id"],
    declared: AgentProviderNativeSetting | null,
    value: unknown,
  ) => {
    if (!declared) {
      if (value !== null)
        throw invalid(provider.id + " does not support " + id);
      return;
    }
    if (!optionSupported(value, declared))
      throw invalid("Unsupported " + id + " for " + provider.id);
  };
  const defaultOf = <T>(
    declared: AgentProviderNativeSetting,
    guard: (value: unknown) => value is T,
  ): T => {
    if (!guard(declared.defaultValue))
      throw new Error(
        provider.id + " declares an invalid " + declared.id + " default",
      );
    return declared.defaultValue;
  };

  const approval = setting("approvalPolicy");
  if (approval && config.approvalPolicy === null)
    config.approvalPolicy =
      approval.defaultValue === "granular"
        ? {
            granular: Object.fromEntries(
              approval.granularFields.map((field) => [field.id, true]),
            ) as unknown as CodexGranularApprovalPolicy,
          }
        : defaultOf(approval, isApprovalPolicyMode);
  check("approvalPolicy", approval, config.approvalPolicy);

  const reviewer = setting("approvalsReviewer");
  if (reviewer)
    config.approvalsReviewer ??= defaultOf(reviewer, isApprovalsReviewer);
  check("approvalsReviewer", reviewer, config.approvalsReviewer);

  const permission = setting("permissionMode");
  if (permission)
    config.permissionMode ??= defaultOf(permission, isAgentPermissionMode);
  check("permissionMode", permission, config.permissionMode);

  return config;
}

/**
 * Merges a settings patch into the current configuration and validates it
 * against the provider: native settings from its declaration, model-scoped
 * settings (effort, tier, summary) from its model catalog. When the model
 * changes, settings the new model does not support fall back to its defaults
 * unless the patch sets them explicitly.
 */
export async function resolveSessionConfig(
  provider: AgentProvider,
  current: AgentSessionConfig,
  patch: Partial<AgentSessionConfig>,
): Promise<AgentSessionConfig> {
  const config = { ...current };
  for (const key of [
    "model",
    "reasoningEffort",
    "reasoningSummary",
    "serviceTier",
    "approvalPolicy",
    "approvalsReviewer",
    "permissionMode",
  ] as const) {
    if (patch[key] !== undefined) Object.assign(config, { [key]: patch[key] });
  }
  Object.assign(config, applyNativeSettings(provider, config));

  const models = await provider.listModels();
  const model =
    config.model === null
      ? (models.find((candidate) => candidate.isDefault) ?? models[0])
      : models.find((candidate) => candidate.id === config.model);
  if (config.model !== null && !model)
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Unknown model for " + provider.id + ": " + config.model,
    );
  const supportsEffort = (value: string | null) =>
    value === null ||
    !!model?.reasoningEfforts.some((effort) => effort.id === value);
  const supportsTier = (value: string | null) =>
    value === null || !!model?.serviceTiers.some((tier) => tier.id === value);
  if (config.model !== current.model) {
    if (
      patch.reasoningEffort === undefined &&
      !supportsEffort(config.reasoningEffort)
    )
      config.reasoningEffort = supportsEffort(
        model?.defaultReasoningEffort ?? null,
      )
        ? (model?.defaultReasoningEffort ?? null)
        : null;
    if (patch.serviceTier === undefined && !supportsTier(config.serviceTier))
      config.serviceTier = supportsTier(model?.defaultServiceTier ?? null)
        ? (model?.defaultServiceTier ?? null)
        : null;
    if (
      patch.reasoningSummary === undefined &&
      !model?.reasoningSummaries.includes(config.reasoningSummary ?? "none")
    )
      config.reasoningSummary =
        model?.defaultReasoningSummary &&
        model.reasoningSummaries.includes(model.defaultReasoningSummary)
          ? model.defaultReasoningSummary
          : null;
  }
  if (!supportsEffort(config.reasoningEffort))
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Unsupported reasoning effort: " + config.reasoningEffort,
    );
  if (!supportsTier(config.serviceTier))
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Unsupported service tier: " + config.serviceTier,
    );
  if (
    config.reasoningSummary !== null &&
    !model?.reasoningSummaries.includes(config.reasoningSummary)
  )
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Unsupported reasoning summary: " + config.reasoningSummary,
    );
  return config;
}

/** Rejects input kinds the session's model does not accept. */
export async function validateInputModalities(
  provider: Pick<AgentProvider, "listModels">,
  modelId: string | null,
  text: string,
  attachments: readonly AgentAttachment[],
): Promise<void> {
  const models = await provider.listModels();
  const model =
    modelId === null
      ? (models.find((candidate) => candidate.isDefault) ?? models[0])
      : models.find((candidate) => candidate.id === modelId);
  if (!model) return;
  if (
    (text ||
      attachments.some(
        (attachment) =>
          attachment.kind === "file" || attachment.kind === "skill",
      )) &&
    !model.inputModalities.includes("text")
  )
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Selected model does not support text input",
    );
  if (
    attachments.some((attachment) => attachment.kind === "image") &&
    !model.inputModalities.includes("image")
  )
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Selected model does not support image input",
    );
  if (
    attachments.some((attachment) => attachment.kind === "audio") &&
    !model.inputModalities.includes("audio")
  )
    throw new ChatRoomError(
      "INVALID_INPUT",
      "Selected model does not support audio input",
    );
}
