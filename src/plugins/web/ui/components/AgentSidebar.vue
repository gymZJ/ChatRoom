<script setup lang="ts">
import { shallowRef } from "vue";
import { useLocale } from "vuetify";
import type {
  AgentModel,
  AgentProviderId,
  AgentProviderStatus,
  AgentSession,
  WorkspaceEntry,
} from "../api.js";
import {
  agentFileName,
  agentModelDisplayName,
  agentProviderIcon,
  agentProviderName,
} from "../utils/agent-display.js";
import AgentCreateSessionPanel from "./AgentCreateSessionPanel.vue";
import AgentProviderIcon from "./AgentProviderIcon.vue";
import AgentProviderStatusPanel from "./AgentProviderStatus.vue";

const props = defineProps<{
  providers: AgentProviderStatus[];
  providerModels: Readonly<Record<AgentProviderId, AgentModel[]>>;
  workspaces: WorkspaceEntry[];
  sessions: AgentSession[];
  selectedId: string | null;
  loading: boolean;
  error: string;
}>();

const emit = defineEmits<{
  "update:selectedId": [sessionId: string | null];
  created: [session: AgentSession];
}>();

const locale = useLocale();
const createOpen = shallowRef(false);

function handleCreated(session: AgentSession) {
  createOpen.value = false;
  emit("created", session);
}

function modelDisplayName(
  provider: AgentProviderId,
  modelId: string | null,
): string {
  return agentModelDisplayName(
    props.providerModels,
    provider,
    modelId,
    locale.t("$vuetify.chatroom.agents.defaultModel"),
  );
}

function sessionStatusText(session: AgentSession): string {
  if (session.status === "waiting_input") {
    if (session.attention?.kind === "approval")
      return locale.t("$vuetify.chatroom.agents.waitingApproval");
    if (session.attention?.kind === "input")
      return locale.t("$vuetify.chatroom.agents.waitingAnswer");
  }
  return locale.t("$vuetify.chatroom.agents.statuses." + session.status);
}
</script>

<template>
  <v-card class="agent-sidebar panel-card">
    <div class="panel-header">
      <div class="panel-title">
        {{ locale.t("$vuetify.chatroom.agents.title") }}
      </div>
      <v-btn
        icon="$mdiPlus"
        size="small"
        variant="text"
        :aria-label="locale.t('$vuetify.chatroom.agents.newSession')"
        @click="createOpen = !createOpen"
      />
    </div>

    <v-divider />

    <v-expand-transition>
      <AgentCreateSessionPanel
        v-if="createOpen"
        :providers="providers"
        :provider-models="providerModels"
        :workspaces="workspaces"
        @created="handleCreated"
      />
    </v-expand-transition>

    <div v-if="error" class="agent-error" role="alert">
      <v-icon icon="$mdiAlertCircleOutline" size="18" />
      <span>{{ error }}</span>
    </div>

    <div class="agent-session-list">
      <v-list v-if="sessions.length" nav density="compact">
        <v-list-item
          v-for="session in sessions"
          :key="session.id"
          :active="selectedId === session.id"
          :data-agent-session-id="session.id"
          rounded="lg"
          @click="emit('update:selectedId', session.id)"
        >
          <template #prepend>
            <AgentProviderIcon
              class="agent-session-provider-icon"
              :icon="agentProviderIcon(providers, session.provider)"
              :size="15"
            />
          </template>
          <v-list-item-title>
            {{ agentProviderName(providers, session.provider) }}
          </v-list-item-title>
          <v-list-item-subtitle>
            {{ agentFileName(session.workspaceRoot) }}
            <template v-if="session.model">
              · {{ modelDisplayName(session.provider, session.model) }}
            </template>
          </v-list-item-subtitle>
          <template #append>
            <span
              class="agent-status-dot"
              :data-status="session.status"
              :data-attention="session.attention?.kind ?? undefined"
              :title="sessionStatusText(session)"
            />
          </template>
        </v-list-item>
      </v-list>
      <div v-else class="empty-inline">
        {{
          loading
            ? locale.t("$vuetify.chatroom.agents.loading")
            : locale.t("$vuetify.chatroom.agents.noSessions")
        }}
      </div>
    </div>

    <v-divider />
    <AgentProviderStatusPanel :providers="providers" />
  </v-card>
</template>

<style scoped>
.agent-sidebar {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: rgb(var(--v-theme-on-surface));
}

.agent-error {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 14px;
  color: rgb(var(--v-theme-error));
  font-size: 0.875rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.agent-session-list {
  min-height: 0;
  overflow-y: auto;
  flex: 1 1 auto;
}

.agent-session-provider-icon {
  margin-inline-end: 10px;
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.agent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.4);
}

.agent-status-dot[data-status="idle"] {
  background: rgb(var(--v-theme-success));
}

.agent-status-dot[data-status="running"] {
  background: rgb(var(--v-theme-primary));
}

.agent-status-dot[data-status="waiting_input"] {
  background: rgb(var(--v-theme-warning));
}

.agent-status-dot[data-status="waiting_input"][data-attention="input"] {
  background: rgb(var(--v-theme-info));
}

.agent-status-dot[data-status="error"] {
  background: rgb(var(--v-theme-error));
}

@media (max-width: 1100px) {
  .agent-sidebar {
    min-height: 0;
    max-height: calc(
      100dvh - var(--v-layout-top, 0px) - var(--app-content-block-start, 0px) -
        var(--app-content-block-end, 0px)
    );
  }
}
</style>
