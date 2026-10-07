<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef } from "vue";
import { useLocale } from "vuetify";
import { api, type AgentProviderId, type AgentProviderStatus } from "../api.js";
import type { AgentProviderDetails } from "../../api-types.js";
import { agentProviderName } from "../utils/agent-display.js";
import { createRequestGate } from "../utils/requests.js";
import AgentProviderIcon from "./AgentProviderIcon.vue";

const props = defineProps<{
  providers: AgentProviderStatus[];
}>();

const locale = useLocale();
const details = shallowRef<
  Partial<Record<AgentProviderId, AgentProviderDetails>>
>({});
const selectedProvider = shallowRef<AgentProviderId | null>(null);
const loading = shallowRef(false);
const requests = createRequestGate();
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const usage = computed(() =>
  selectedProvider.value
    ? (details.value[selectedProvider.value]?.accountUsage ?? null)
    : null,
);

onMounted(() => {
  refreshTimer = setInterval(() => {
    if (selectedProvider.value) void loadDetails(selectedProvider.value);
  }, 60_000);
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});

async function toggle(provider: AgentProviderId) {
  if (selectedProvider.value === provider) {
    requests.invalidate();
    selectedProvider.value = null;
    loading.value = false;
    return;
  }
  selectedProvider.value = provider;
  await loadDetails(provider);
}

async function loadDetails(provider: AgentProviderId) {
  const request = requests.begin();
  loading.value = true;
  try {
    const value = await api<AgentProviderDetails>(
      `/agents/providers/${provider}/details`,
      { timeoutMs: 15_000, signal: request.signal },
    );
    if (!requests.isCurrent(request)) return;
    details.value = { ...details.value, [provider]: value };
  } catch {
    // Details are optional; base availability stays visible.
  } finally {
    if (requests.isCurrent(request)) loading.value = false;
  }
}

function statusText(provider: AgentProviderStatus): string {
  if (!provider.installed)
    return locale.t("$vuetify.chatroom.agents.providerUnavailable");
  if (!provider.authenticated)
    return locale.t("$vuetify.chatroom.agents.providerNotAuthenticated");
  const value = details.value[provider.id];
  return [
    locale.t("$vuetify.chatroom.agents.providerAvailable"),
    value?.configRequirements != null
      ? locale.t("$vuetify.chatroom.agents.managedRequirementsAvailable")
      : null,
    value?.rateLimits != null
      ? locale.t("$vuetify.chatroom.agents.rateLimitsAvailable")
      : null,
    provider.capabilities?.webSearch
      ? locale.t("$vuetify.chatroom.agents.webSearch")
      : null,
    provider.capabilities?.imageGeneration
      ? locale.t("$vuetify.chatroom.agents.imageGeneration")
      : null,
    provider.version ? provider.displayName + " " + provider.version : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function windowLabel(id: string, label: string | null): string {
  if (label) return label;
  const key: Record<string, string> = {
    five_hour: "$vuetify.chatroom.agents.quotaFiveHour",
    seven_day: "$vuetify.chatroom.agents.quotaSevenDay",
    seven_day_oauth_apps: "$vuetify.chatroom.agents.quotaOauthApps",
    seven_day_opus: "$vuetify.chatroom.agents.quotaOpus",
    seven_day_sonnet: "$vuetify.chatroom.agents.quotaSonnet",
  };
  return key[id] ? locale.t(key[id]) : id;
}

function percent(value: number | null): string {
  return value === null
    ? "—"
    : locale.t(
        "$vuetify.chatroom.agents.quotaPercent",
        String(Math.round(value)),
      );
}

function barWidth(value: number | null): string {
  if (value === null) return "0%";
  return Math.min(100, Math.max(0, value)) + "%";
}

function resetLabel(value: string | null): string {
  if (!value) return "";
  const milliseconds = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    return locale.t("$vuetify.chatroom.agents.quotaResetSoon");
  const minutes = Math.ceil(milliseconds / 60_000);
  let duration: string;
  if (minutes < 60) duration = minutes + "m";
  else {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    duration =
      hours < 48
        ? hours + "h" + (remainingMinutes ? " " + remainingMinutes + "m" : "")
        : Math.ceil(hours / 24) + "d";
  }
  return locale.t("$vuetify.chatroom.agents.quotaResetsIn", duration);
}
</script>

<template>
  <div class="agent-provider-strip">
    <div
      v-for="provider in providers"
      :key="provider.id"
      class="agent-provider-pill"
      :data-state="
        !provider.installed
          ? 'unavailable'
          : provider.authenticated
            ? 'ready'
            : 'warning'
      "
      :title="statusText(provider)"
      :aria-label="statusText(provider)"
      :aria-expanded="selectedProvider === provider.id"
      :data-expanded="selectedProvider === provider.id"
      role="button"
      tabindex="0"
      @click="toggle(provider.id)"
      @keydown.enter.prevent="toggle(provider.id)"
      @keydown.space.prevent="toggle(provider.id)"
    >
      <AgentProviderIcon :icon="provider.icon" :size="14" />
      <span class="agent-provider-pill-name">
        {{ agentProviderName(providers, provider.id) }}
      </span>
      <span class="agent-provider-pill-dot" />
    </div>
  </div>

  <div v-if="selectedProvider" class="agent-provider-quota">
    <div class="agent-provider-quota-header">
      <span>{{ agentProviderName(providers, selectedProvider) }}</span>
      <span v-if="usage?.subscriptionType">{{ usage.subscriptionType }}</span>
    </div>
    <div v-if="loading" class="agent-provider-quota-unavailable">
      {{ locale.t("$vuetify.chatroom.agents.loading") }}
    </div>
    <div
      v-else-if="!(usage?.windows.length ?? 0)"
      class="agent-provider-quota-unavailable"
    >
      {{ locale.t("$vuetify.chatroom.agents.quotaUnavailable") }}
    </div>
    <template v-else>
      <div
        v-for="window in usage?.windows ?? []"
        :key="window.id"
        class="agent-provider-quota-row"
        :title="resetLabel(window.resetsAt)"
      >
        <span class="agent-provider-quota-label">
          {{ windowLabel(window.id, window.label) }}
        </span>
        <div class="agent-provider-quota-track" aria-hidden="true">
          <span
            class="agent-provider-quota-fill"
            :style="{ width: barWidth(window.utilization) }"
          />
        </div>
        <span class="agent-provider-quota-value">
          {{ percent(window.utilization) }}
        </span>
        <span class="agent-provider-quota-reset">
          {{ resetLabel(window.resetsAt) }}
        </span>
      </div>
      <div v-if="usage?.extraUsage?.enabled" class="agent-provider-quota-extra">
        <span>{{ locale.t("$vuetify.chatroom.agents.quotaExtraUsage") }}</span>
        <span>{{ percent(usage.extraUsage.utilization) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.agent-provider-strip {
  flex: 0 0 auto;
  min-height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
}

.agent-provider-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 9px;
  border: 1px solid rgba(var(--v-border-color), 0.18);
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.045);
  color: rgba(var(--v-theme-on-surface), 0.72);
  font-size: 0.7rem;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.agent-provider-pill:hover,
.agent-provider-pill:focus-visible,
.agent-provider-pill[data-expanded="true"] {
  border-color: rgba(var(--v-theme-primary), 0.46);
  background: rgba(var(--v-theme-primary), 0.09);
  outline: none;
}

.agent-provider-pill-name {
  line-height: 1;
}

.agent-provider-pill-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.32);
}

.agent-provider-pill[data-state="ready"] .agent-provider-pill-dot {
  background: rgb(var(--v-theme-success));
}

.agent-provider-pill[data-state="warning"] .agent-provider-pill-dot {
  background: rgb(var(--v-theme-warning));
}

.agent-provider-pill[data-state="unavailable"] {
  opacity: 0.55;
}

.agent-provider-pill[data-state="unavailable"] .agent-provider-pill-dot {
  background: rgb(var(--v-theme-error));
}

.agent-provider-quota {
  flex: 0 0 auto;
  padding: 8px 12px 10px;
  border-top: 1px solid rgba(var(--v-border-color), 0.12);
}

.agent-provider-quota-header,
.agent-provider-quota-extra {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.68rem;
  font-weight: 600;
}

.agent-provider-quota-header > span:last-child {
  color: rgba(var(--v-theme-on-surface), 0.46);
  font-size: 0.62rem;
  font-weight: 500;
  text-transform: uppercase;
}

.agent-provider-quota-unavailable {
  margin-top: 7px;
  color: rgba(var(--v-theme-on-surface), 0.46);
  font-size: 0.64rem;
  line-height: 1.4;
}

.agent-provider-quota-row {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) auto;
  align-items: center;
  gap: 6px 8px;
  margin-top: 7px;
}

.agent-provider-quota-label,
.agent-provider-quota-value,
.agent-provider-quota-reset {
  font-size: 0.64rem;
  white-space: nowrap;
}

.agent-provider-quota-label {
  color: rgba(var(--v-theme-on-surface), 0.64);
}

.agent-provider-quota-value,
.agent-provider-quota-reset {
  text-align: end;
}

.agent-provider-quota-value {
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.agent-provider-quota-reset {
  grid-column: 2 / 4;
  margin-top: -3px;
  color: rgba(var(--v-theme-on-surface), 0.4);
}

.agent-provider-quota-track {
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.1);
}

.agent-provider-quota-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: rgb(var(--v-theme-primary));
}

.agent-provider-quota-extra {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(var(--v-border-color), 0.08);
  font-weight: 500;
}
</style>
