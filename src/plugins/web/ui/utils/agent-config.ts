import type {
  AgentModel,
  AgentProviderId,
  AgentProviderStatus,
  AgentSession,
} from "../api.js";

export type ReasoningSummary = "auto" | "concise" | "detailed" | "none";
export type ApprovalPolicyMode =
  "untrusted" | "on-request" | "granular" | "never";
export type ApprovalPolicy = AgentSession["approvalPolicy"];
export type GranularApproval = Extract<
  NonNullable<ApprovalPolicy>,
  { granular: object }
>["granular"];
export type ApprovalsReviewer = AgentSession["approvalsReviewer"];
export type PermissionMode = AgentSession["permissionMode"];
export type NativeSettingId =
  "approvalPolicy" | "approvalsReviewer" | "permissionMode";
export type SessionConfig = Pick<
  AgentSession,
  | "model"
  | "reasoningEffort"
  | "reasoningSummary"
  | "serviceTier"
  | "approvalPolicy"
  | "approvalsReviewer"
  | "permissionMode"
>;

export function defaultGranularApproval(): GranularApproval {
  return {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true,
  };
}

export function nativeSetting(
  providers: readonly AgentProviderStatus[],
  provider: AgentProviderId,
  id: NativeSettingId,
) {
  return (
    providers
      .find((item) => item.id === provider)
      ?.nativeSettings.find((setting) => setting.id === id) ?? null
  );
}

export function approvalPolicyMode(
  value: ApprovalPolicy | ApprovalPolicyMode,
  fallback: string | null = null,
): ApprovalPolicyMode | null {
  if (value && typeof value === "object") return "granular";
  const candidate = value ?? fallback;
  return candidate === "untrusted" ||
    candidate === "on-request" ||
    candidate === "granular" ||
    candidate === "never"
    ? candidate
    : null;
}

export function approvalsReviewerValue(
  value: ApprovalsReviewer,
  fallback: string | null,
): ApprovalsReviewer {
  const candidate = value ?? fallback;
  return candidate === "user" ||
    candidate === "auto_review" ||
    candidate === "guardian_subagent"
    ? candidate
    : null;
}

export function permissionModeValue(
  value: PermissionMode,
  fallback: string | null,
): PermissionMode {
  const candidate = value ?? fallback;
  return candidate === "read-only" ||
    candidate === "workspace-write" ||
    candidate === "danger-full-access"
    ? candidate
    : null;
}

export function nativeConfig(
  providers: readonly AgentProviderStatus[],
  provider: AgentProviderId,
  approvalMode: ApprovalPolicyMode | null,
  granular: GranularApproval,
  reviewer: ApprovalsReviewer,
  permissionMode: PermissionMode,
): Pick<
  SessionConfig,
  "approvalPolicy" | "approvalsReviewer" | "permissionMode"
> {
  const approvalSetting = nativeSetting(providers, provider, "approvalPolicy");
  const reviewerSetting = nativeSetting(
    providers,
    provider,
    "approvalsReviewer",
  );
  const permissionSetting = nativeSetting(
    providers,
    provider,
    "permissionMode",
  );
  const effectiveApprovalMode = approvalPolicyMode(
    approvalMode,
    approvalSetting?.defaultValue ?? null,
  );
  const supportedPermission = permissionSetting?.options.some(
    (option) => option.id === permissionMode,
  )
    ? permissionMode
    : null;

  return {
    approvalPolicy: approvalSetting
      ? effectiveApprovalMode === "granular"
        ? { granular: { ...granular } }
        : effectiveApprovalMode
      : null,
    approvalsReviewer: reviewerSetting
      ? approvalsReviewerValue(reviewer, reviewerSetting.defaultValue)
      : null,
    permissionMode: permissionSetting
      ? permissionModeValue(supportedPermission, permissionSetting.defaultValue)
      : null,
  };
}

export function modelMetadata(
  providerModels: Readonly<Record<AgentProviderId, AgentModel[]>>,
  provider: AgentProviderId,
  modelId: string | null,
): AgentModel | null {
  const models = providerModels[provider] ?? [];
  return modelId
    ? (models.find((model) => model.id === modelId) ?? null)
    : (models.find((model) => model.isDefault) ?? models[0] ?? null);
}

export function effectiveModelId(
  providerModels: Readonly<Record<AgentProviderId, AgentModel[]>>,
  provider: AgentProviderId,
  modelId: string | null,
): string | null {
  if (modelId) return modelId;
  return (
    (providerModels[provider] ?? []).find((model) => model.isDefault)?.id ??
    null
  );
}
