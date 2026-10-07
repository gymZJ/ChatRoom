<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import CodeViewer from "./CodeViewer.vue";

const props = defineProps<{
  command: string;
  cwd: string | null;
  output: string;
  exitCode: number | null;
  status: "running" | "completed" | "waiting" | "interrupted" | "failed";
}>();

const locale = useLocale();
const copyError = shallowRef("");
const expanded = shallowRef(
  props.status !== "completed" ||
    (props.exitCode !== null && props.exitCode !== 0),
);

watch(
  () => [props.status, props.exitCode] as const,
  ([status, exitCode]) => {
    if (
      status === "running" ||
      status === "failed" ||
      (exitCode !== null && exitCode !== 0)
    )
      expanded.value = true;
  },
);

const preview = computed(() => {
  let value = props.command.trim();
  value = value.replace(
    /^(?:\/usr\/bin\/|\/bin\/)?(?:zsh|bash|sh)\s+-l?c\s+/,
    "",
  );
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    value = value.slice(1, -1);
  return (
    value.replace(/\\"/g, '"').replace(/\s+/g, " ").trim() ||
    locale.t("$vuetify.chatroom.agents.command")
  );
});

const state = computed<"running" | "success" | "error" | "neutral">(() => {
  if (props.status === "running" || props.status === "waiting")
    return "running";
  if (
    props.status === "failed" ||
    (props.exitCode !== null && props.exitCode !== 0)
  )
    return "error";
  if (props.status === "completed" && props.exitCode === 0) return "success";
  return "neutral";
});

const statusText = computed(() => {
  if (state.value === "running")
    return locale.t("$vuetify.chatroom.agents.commandRunning");
  if (state.value === "error")
    return props.exitCode === null
      ? locale.t("$vuetify.chatroom.agents.commandFailed")
      : locale.t("$vuetify.chatroom.agents.exitCode", props.exitCode);
  if (state.value === "success")
    return locale.t("$vuetify.chatroom.agents.commandSucceeded");
  return locale.t("$vuetify.chatroom.agents.command");
});

async function copyCommand() {
  copyError.value = "";
  try {
    await navigator.clipboard.writeText(props.command);
  } catch {
    copyError.value = locale.t("$vuetify.chatroom.code.copyFailed");
  }
}
</script>

<template>
  <details
    class="agent-command"
    :data-state="state"
    :open="expanded"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary
      class="agent-command-main"
      :aria-label="locale.t('$vuetify.chatroom.agents.commandDetails')"
    >
      <div class="agent-command-label">
        <v-icon icon="$mdiConsoleLine" size="16" />
        <span>{{ locale.t("$vuetify.chatroom.agents.command") }}</span>
        <span class="agent-command-status">
          <span class="agent-command-status-dot" />
          {{ statusText }}
        </span>
      </div>

      <div class="agent-command-line">
        <code class="mono" :title="command">{{ preview }}</code>
        <v-btn
          icon="$mdiContentCopy"
          size="x-small"
          variant="text"
          class="agent-command-copy"
          :aria-label="locale.t('$vuetify.chatroom.code.copy')"
          @click.stop="copyCommand"
        />
        <v-icon
          icon="$mdiChevronDown"
          size="18"
          class="agent-command-toggle"
          :class="{ 'agent-command-toggle-open': expanded }"
        />
      </div>
      <div v-if="copyError" class="agent-command-copy-error" role="alert">
        {{ copyError }}
      </div>
    </summary>

    <div v-if="expanded" class="agent-command-details">
      <div class="agent-command-full">
        <CodeViewer
          :text="command"
          filename="command.sh"
          language="bash"
          :toolbar="false"
        />
      </div>

      <div v-if="cwd || exitCode !== null" class="agent-command-meta">
        <span v-if="cwd" class="agent-command-cwd mono" :title="cwd">
          {{ cwd }}
        </span>
        <span v-if="exitCode !== null" class="agent-command-exit">
          {{ locale.t("$vuetify.chatroom.agents.exitCode", exitCode) }}
        </span>
      </div>

      <template v-if="output">
        <div class="agent-command-output-label">
          {{ locale.t("$vuetify.chatroom.agents.commandOutput") }}
        </div>
        <div class="agent-command-code output">
          <pre
            v-if="state === 'running'"
            class="agent-command-output-plain mono"
            >{{ output }}</pre>
          <CodeViewer
            v-else
            :text="output"
            filename="output.txt"
            :toolbar="false"
          />
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.agent-command {
  width: 100%;
  display: block;
  flex: 0 0 auto;
  min-inline-size: 0;
  border-inline-start: 2px solid rgba(var(--v-border-color), 0.3);
  background: rgba(var(--v-theme-surface-variant), 0.12);
}

.agent-command-main {
  cursor: pointer;
  list-style: none;
  padding: 7px 9px 8px;
}

.agent-command-main::-webkit-details-marker {
  display: none;
}
.agent-command-main:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
}

.agent-command-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.68rem;
  font-weight: 600;
}

.agent-command-status {
  margin-inline-start: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 500;
  white-space: nowrap;
}

.agent-command-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--v-theme-on-surface), 0.42);
}

.agent-command[data-state="running"] .agent-command-status-dot {
  background: rgb(var(--v-theme-warning));
}

.agent-command[data-state="success"] .agent-command-status-dot {
  background: rgb(var(--v-theme-success));
}

.agent-command[data-state="error"] {
  border-color: rgba(var(--v-theme-error), 0.36);
}

.agent-command[data-state="error"] .agent-command-status-dot {
  background: rgb(var(--v-theme-error));
}

.agent-command-line {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
}

.agent-command-line code {
  min-width: 0;
  display: block;
  overflow: hidden;
  color: rgba(var(--v-theme-on-surface), 0.92);
  font-size: 0.76rem;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-command-copy,
.agent-command-toggle {
  opacity: 0.66;
}

.agent-command-copy:hover,
.agent-command-toggle:hover {
  opacity: 1;
}

.agent-command-toggle {
  transition: transform 120ms ease;
}

.agent-command-toggle-open {
  transform: rotate(180deg);
}

.agent-command-copy-error {
  padding: 6px 10px;
  color: rgb(var(--v-theme-error));
  font-size: 0.8rem;
}

.agent-command-details {
  border-top: 1px solid rgba(var(--v-border-color), 0.18);
}

.agent-command-full,
.agent-command-code {
  background: rgba(var(--v-theme-on-surface), 0.025);
}

.agent-command-full :deep(.code-block),
.agent-command-code :deep(.code-block) {
  padding: 9px 10px 11px;
  font-size: 11.5px;
  line-height: 1.55;
}

.agent-command-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 10px;
  border-top: 1px solid rgba(var(--v-border-color), 0.12);
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-size: 0.68rem;
}

.agent-command-cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-command-exit {
  margin-inline-start: auto;
  white-space: nowrap;
}

.agent-command-output-label {
  padding: 5px 10px;
  border-top: 1px solid rgba(var(--v-border-color), 0.12);
  color: rgba(var(--v-theme-on-surface), 0.56);
  font-size: 0.68rem;
  font-weight: 600;
}

.agent-command-code.output :deep(.code-block) {
  color: rgba(var(--v-theme-on-surface), 0.8);
}

@media (max-width: 960px) {
  .agent-command-status {
    font-size: 0;
  }

  .agent-command-status-dot {
    margin-inline-end: 1px;
  }
}
.agent-command-output-plain {
  max-height: 45dvh;
  margin: 0;
  padding: 10px 12px;
  overflow: auto;
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
