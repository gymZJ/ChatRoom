import {
  computed,
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import { useLocale } from "vuetify";
import {
  api,
  type AgentModel,
  type AgentProviderId,
  type AgentProviderStatus,
  type AgentSession,
} from "../api.js";
import type { AgentReviewTarget } from "../../api-types.js";
import {
  approvalPolicyMode,
  approvalsReviewerValue,
  defaultGranularApproval,
  modelMetadata,
  nativeConfig,
  nativeSetting,
  permissionModeValue,
  type ApprovalPolicyMode,
  type ApprovalsReviewer,
  type GranularApproval,
  type PermissionMode,
  type ReasoningSummary,
  type SessionConfig,
} from "../utils/agent-config.js";
import { errorMessage } from "../utils/errors.js";
import type { AgentRefreshHint } from "./useRuntimeEvents.js";

interface UseAgentSessionActionsOptions {
  selectedId: Ref<string | null>;
  selected: ComputedRef<AgentSession | null>;
  sessions: Ref<AgentSession[]>;
  providers: Ref<AgentProviderStatus[]>;
  providerModels: Ref<Record<AgentProviderId, AgentModel[]>>;
  composerBusy: Ref<boolean>;
  error: Ref<string>;
  refresh: (changes: AgentRefreshHint[] | null) => void | Promise<void>;
  reconcileSession: (session: AgentSession) => void;
  removeSession: (sessionId: string) => void;
}

export function useAgentSessionActions(options: UseAgentSessionActionsOptions) {
  const locale = useLocale();
  const modelSettingsOpen = shallowRef(false);
  const settingsModel = shallowRef<string | null>(null);
  const settingsReasoningEffort = shallowRef<string | null>(null);
  const settingsReasoningSummary = shallowRef<ReasoningSummary | null>(null);
  const settingsServiceTier = shallowRef<string | null>(null);
  const settingsApprovalPolicyMode = shallowRef<ApprovalPolicyMode | null>(
    null,
  );
  const settingsGranularApproval = shallowRef<GranularApproval>(
    defaultGranularApproval(),
  );
  const settingsApprovalsReviewer = shallowRef<ApprovalsReviewer>(null);
  const settingsPermissionMode = shallowRef<PermissionMode>(null);
  const reviewOpen = shallowRef(false);
  const reviewType =
    shallowRef<AgentReviewTarget["type"]>("uncommittedChanges");
  const reviewValue = shallowRef("");
  const reviewTitle = shallowRef("");
  const reviewStarting = shallowRef(false);
  const reviewError = shallowRef("");
  const modelSwitching = shallowRef(false);
  const switchingProvider = shallowRef(false);
  const interrupting = shallowRef(false);
  const deleteDialog = shallowRef(false);
  const deleteTargetId = shallowRef<string | null>(null);
  const deletingSession = shallowRef(false);

  let disposed = false;
  let selectionGeneration = 0;
  const modelLoadGeneration = new Map<AgentProviderId, number>();
  const sessionMutationGeneration = new Map<string, number>();

  const selectedApprovalPolicySetting = computed(() =>
    options.selected.value
      ? nativeSetting(
          options.providers.value,
          options.selected.value.provider,
          "approvalPolicy",
        )
      : null,
  );
  const selectedApprovalsReviewerSetting = computed(() =>
    options.selected.value
      ? nativeSetting(
          options.providers.value,
          options.selected.value.provider,
          "approvalsReviewer",
        )
      : null,
  );
  const selectedPermissionModeSetting = computed(() =>
    options.selected.value
      ? nativeSetting(
          options.providers.value,
          options.selected.value.provider,
          "permissionMode",
        )
      : null,
  );
  const selectedProviderModels = computed(() =>
    options.selected.value
      ? (options.providerModels.value[options.selected.value.provider] ?? [])
      : [],
  );
  const selectedModelMetadata = computed(() =>
    options.selected.value
      ? modelMetadata(
          options.providerModels.value,
          options.selected.value.provider,
          options.selected.value.model,
        )
      : null,
  );
  const selectedProviderStatus = computed(() =>
    options.selected.value
      ? (options.providers.value.find(
          (provider) => provider.id === options.selected.value?.provider,
        ) ?? null)
      : null,
  );
  const reviewTypes = computed(() =>
    (["uncommittedChanges", "baseBranch", "commit", "custom"] as const).map(
      (value) => ({
        value,
        title: locale.t(`$vuetify.chatroom.agents.reviewTargets.${value}`),
      }),
    ),
  );
  const reviewFieldLabel = computed(() =>
    locale.t(`$vuetify.chatroom.agents.reviewFields.${reviewType.value}`),
  );
  const canStartReview = computed(
    () =>
      options.selected.value?.status === "idle" &&
      Boolean(selectedProviderStatus.value?.features.nativeReview) &&
      !reviewStarting.value &&
      !options.composerBusy.value &&
      !modelSwitching.value &&
      !switchingProvider.value &&
      (reviewType.value === "uncommittedChanges" ||
        Boolean(reviewValue.value.trim())),
  );
  const switchTargets = computed(() => {
    if (!options.selected.value) return [];
    return options.providers.value.filter(
      (provider) =>
        provider.id !== options.selected.value?.provider &&
        provider.installed &&
        provider.authenticated,
    );
  });

  watch(reviewType, () => {
    reviewValue.value = "";
    reviewTitle.value = "";
    reviewError.value = "";
  });

  watch(
    options.selectedId,
    () => {
      selectionGeneration += 1;
      modelSwitching.value = false;
      switchingProvider.value = false;
      interrupting.value = false;
      reviewStarting.value = false;
      modelSettingsOpen.value = false;
      reviewOpen.value = false;
      deleteDialog.value = false;
      deleteTargetId.value = null;
      deletingSession.value = false;
    },
    { flush: "sync" },
  );

  watch(options.sessions, (next) => {
    const target = deleteTargetId.value;
    if (target && !next.some((session) => session.id === target)) {
      deleteDialog.value = false;
      deleteTargetId.value = null;
    }
  });

  onScopeDispose(() => {
    disposed = true;
    modelLoadGeneration.clear();
    sessionMutationGeneration.clear();
  });

  async function loadModels(
    provider: AgentProviderId,
    errorSessionId: string | null = null,
  ) {
    const status = options.providers.value.find((item) => item.id === provider);
    if (status && (!status.installed || !status.authenticated)) {
      options.providerModels.value = {
        ...options.providerModels.value,
        [provider]: [],
      };
      return;
    }

    const generation = (modelLoadGeneration.get(provider) ?? 0) + 1;
    modelLoadGeneration.set(provider, generation);
    try {
      const models = await api<AgentModel[]>(
        "/agents/providers/" + provider + "/models",
        { timeoutMs: 15_000 },
      );
      if (disposed || modelLoadGeneration.get(provider) !== generation) return;
      options.providerModels.value = {
        ...options.providerModels.value,
        [provider]: models,
      };
    } catch (cause) {
      if (disposed || modelLoadGeneration.get(provider) !== generation) return;
      options.providerModels.value = {
        ...options.providerModels.value,
        [provider]: [],
      };
      if (
        errorSessionId === null ||
        options.selectedId.value === errorSessionId
      )
        options.error.value = errorMessage(cause);
    }
  }

  async function startReview() {
    const session = options.selected.value;
    if (!session || !canStartReview.value) return;
    const token = selectionToken(session.id);
    const value = reviewValue.value.trim();
    let target: AgentReviewTarget;
    switch (reviewType.value) {
      case "uncommittedChanges":
        target = { type: "uncommittedChanges" };
        break;
      case "baseBranch":
        target = { type: "baseBranch", branch: value };
        break;
      case "commit":
        target = {
          type: "commit",
          sha: value,
          title: reviewTitle.value.trim() || null,
        };
        break;
      case "custom":
        target = { type: "custom", instructions: value };
        break;
    }
    reviewStarting.value = true;
    reviewError.value = "";
    try {
      await api(`/agents/sessions/${encodeURIComponent(session.id)}/review`, {
        method: "POST",
        body: JSON.stringify({ target }),
        timeoutMs: 30_000,
      });
      if (selectionIsCurrent(token)) reviewOpen.value = false;
    } catch (cause) {
      if (selectionIsCurrent(token)) reviewError.value = errorMessage(cause);
    } finally {
      if (selectionIsCurrent(token)) reviewStarting.value = false;
    }
  }

  async function interrupt() {
    const session = options.selected.value;
    if (!session || interrupting.value) return;
    const token = selectionToken(session.id);
    interrupting.value = true;
    options.error.value = "";
    try {
      await api(
        "/agents/sessions/" + encodeURIComponent(session.id) + "/interrupt",
        { method: "POST" },
      );
    } catch (cause) {
      if (selectionIsCurrent(token)) options.error.value = errorMessage(cause);
    } finally {
      if (selectionIsCurrent(token)) interrupting.value = false;
    }
  }

  async function switchProvider(provider: AgentProviderId) {
    const session = options.selected.value;
    if (!session || provider === session.provider || switchingProvider.value)
      return;
    const status = options.providers.value.find((item) => item.id === provider);
    if (!status?.installed || !status.authenticated) return;
    const token = selectionToken(session.id);
    const mutation = beginSessionMutation(session.id);

    switchingProvider.value = true;
    options.error.value = "";
    try {
      const updated = await api<AgentSession>(
        "/agents/sessions/" + encodeURIComponent(session.id) + "/provider",
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            model: null,
            reasoningEffort: null,
            reasoningSummary: null,
            serviceTier: null,
          }),
          timeoutMs: 30_000,
        },
      );
      if (sessionMutationIsCurrent(mutation)) {
        options.reconcileSession(updated);
        await loadModels(updated.provider, session.id);
      } else {
        reconcileStaleSessionMutation(session.id);
      }
    } catch (cause) {
      if (selectionIsCurrent(token)) options.error.value = errorMessage(cause);
    } finally {
      if (selectionIsCurrent(token)) switchingProvider.value = false;
    }
  }

  function openDeleteDialog() {
    const session = options.selected.value;
    if (!session) return;
    deleteTargetId.value = session.id;
    deleteDialog.value = true;
  }

  async function deleteSession() {
    const sessionId = deleteTargetId.value;
    if (!sessionId || deletingSession.value) return;
    deletingSession.value = true;
    options.error.value = "";
    try {
      await api("/agents/sessions/" + encodeURIComponent(sessionId), {
        method: "DELETE",
      });
      options.removeSession(sessionId);
      if (deleteTargetId.value === sessionId) {
        deletingSession.value = false;
        deleteDialog.value = false;
        deleteTargetId.value = null;
      }
    } catch (cause) {
      if (deleteTargetId.value === sessionId) {
        deletingSession.value = false;
        options.error.value = errorMessage(cause);
      }
    }
  }

  function openModelSettings() {
    const session = options.selected.value;
    if (!session) return;
    settingsModel.value = session.model;
    settingsReasoningEffort.value = session.reasoningEffort;
    settingsReasoningSummary.value = session.reasoningSummary;
    settingsServiceTier.value = session.serviceTier;
    settingsApprovalPolicyMode.value = approvalPolicyMode(
      session.approvalPolicy,
      selectedApprovalPolicySetting.value?.defaultValue ?? null,
    );
    settingsGranularApproval.value =
      session.approvalPolicy &&
      typeof session.approvalPolicy === "object" &&
      "granular" in session.approvalPolicy
        ? { ...session.approvalPolicy.granular }
        : defaultGranularApproval();
    settingsApprovalsReviewer.value = approvalsReviewerValue(
      session.approvalsReviewer,
      selectedApprovalsReviewerSetting.value?.defaultValue ?? null,
    );
    settingsPermissionMode.value = permissionModeValue(
      session.permissionMode,
      selectedPermissionModeSetting.value?.defaultValue ?? null,
    );
    modelSettingsOpen.value = true;
  }

  async function saveModelSettings() {
    const session = options.selected.value;
    if (!session) return;
    const saved = await configureSelected({
      model: settingsModel.value,
      reasoningEffort: settingsReasoningEffort.value,
      reasoningSummary: settingsReasoningSummary.value,
      serviceTier: settingsServiceTier.value,
      ...nativeConfig(
        options.providers.value,
        session.provider,
        settingsApprovalPolicyMode.value,
        settingsGranularApproval.value,
        settingsApprovalsReviewer.value,
        settingsPermissionMode.value,
      ),
    });
    if (saved) modelSettingsOpen.value = false;
  }

  async function configureSelected(
    patch: Partial<SessionConfig>,
  ): Promise<boolean> {
    const session = options.selected.value;
    if (
      !session ||
      session.status !== "idle" ||
      modelSwitching.value ||
      switchingProvider.value
    )
      return false;
    const token = selectionToken(session.id);
    const mutation = beginSessionMutation(session.id);
    modelSwitching.value = true;
    options.error.value = "";
    try {
      const updated = await api<AgentSession>(
        `/agents/sessions/${encodeURIComponent(session.id)}/config`,
        { method: "PUT", body: JSON.stringify(patch), timeoutMs: 30_000 },
      );
      if (!sessionMutationIsCurrent(mutation)) {
        reconcileStaleSessionMutation(session.id);
        return false;
      }
      options.reconcileSession(updated);
      return selectionIsCurrent(token);
    } catch (cause) {
      if (selectionIsCurrent(token)) options.error.value = errorMessage(cause);
      return false;
    } finally {
      if (selectionIsCurrent(token)) modelSwitching.value = false;
    }
  }

  function selectionToken(sessionId: string) {
    return { sessionId, generation: selectionGeneration };
  }

  function selectionIsCurrent(token: {
    sessionId: string;
    generation: number;
  }): boolean {
    return (
      options.selectedId.value === token.sessionId &&
      selectionGeneration === token.generation
    );
  }

  function beginSessionMutation(sessionId: string) {
    const generation = (sessionMutationGeneration.get(sessionId) ?? 0) + 1;
    sessionMutationGeneration.set(sessionId, generation);
    return { sessionId, generation };
  }

  function sessionMutationIsCurrent(token: {
    sessionId: string;
    generation: number;
  }): boolean {
    return sessionMutationGeneration.get(token.sessionId) === token.generation;
  }

  function reconcileStaleSessionMutation(sessionId: string) {
    void options.refresh([
      { sessionId, turnIds: [], itemIds: [], deleted: false },
    ]);
  }

  return {
    modelSettingsOpen,
    settingsModel,
    settingsReasoningEffort,
    settingsReasoningSummary,
    settingsServiceTier,
    settingsApprovalPolicyMode,
    settingsGranularApproval,
    settingsApprovalsReviewer,
    settingsPermissionMode,
    reviewOpen,
    reviewType,
    reviewValue,
    reviewTitle,
    reviewStarting,
    reviewError,
    modelSwitching,
    switchingProvider,
    interrupting,
    deleteDialog,
    deletingSession,
    selectedApprovalPolicySetting,
    selectedApprovalsReviewerSetting,
    selectedPermissionModeSetting,
    selectedProviderModels,
    selectedModelMetadata,
    selectedProviderStatus,
    reviewTypes,
    reviewFieldLabel,
    canStartReview,
    switchTargets,
    loadModels,
    startReview,
    interrupt,
    switchProvider,
    openDeleteDialog,
    deleteSession,
    openModelSettings,
    saveModelSettings,
  };
}
