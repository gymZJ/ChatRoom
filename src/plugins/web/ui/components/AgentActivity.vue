<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";
import type { AgentItem } from "../api.js";
import CodeViewer from "./CodeViewer.vue";
import MarkdownContent from "./MarkdownContent.vue";

type ActivityItem = Extract<
  AgentItem,
  { type: "tool" | "file_change" | "turn_diff" | "plan" | "artifact" }
>;
const props = defineProps<{ item: ActivityItem }>();
const locale = useLocale();
const expanded = shallowRef(
  props.item.status === "running" || props.item.status === "failed",
);
watch(
  () => props.item.status,
  (status) => {
    if (status === "running" || status === "failed") expanded.value = true;
  },
);
const title = computed(() => {
  const item = props.item;
  if (item.type === "tool")
    return [item.server, item.name].filter(Boolean).join(" / ");
  const key = {
    file_change: "fileChanges",
    turn_diff: "turnDiff",
    plan: "plan",
    artifact: "artifact",
  }[item.type];
  return locale.t("$vuetify.chatroom.agents." + key);
});
const icon = computed(() => {
  if (props.item.type === "tool") return "$mdiTuneVariant";
  if (props.item.type === "file_change" || props.item.type === "turn_diff")
    return "$mdiFileCompare";
  return props.item.type === "plan" ? "$mdiTextBoxOutline" : "$mdiFileOutline";
});
function planStepKey(
  item: Extract<AgentItem, { type: "plan" }>,
  index: number,
): string {
  const step = item.steps[index]!;
  let occurrence = 0;
  for (let cursor = 0; cursor < index; cursor++)
    if (item.steps[cursor]?.step === step.step) occurrence++;
  return item.id + ":" + step.step + ":" + occurrence;
}
</script>

<template>
  <details
    class="agent-activity"
    :open="expanded"
    :data-status="item.status"
    @toggle="expanded = ($event.target as HTMLDetailsElement).open"
  >
    <summary class="agent-activity-heading" :title="title">
      <v-icon :icon="icon" size="18" />
      <span class="agent-activity-title">{{ title }}</span>
      <v-progress-circular
        v-if="item.status === 'running'"
        indeterminate
        size="14"
        width="2"
      />
      <v-icon
        v-else-if="item.status === 'failed'"
        icon="$mdiAlertCircleOutline"
        size="16"
        color="error"
      />
      <v-icon
        class="agent-activity-chevron"
        icon="$mdiChevronRight"
        size="16"
      />
    </summary>
    <div v-if="expanded" class="agent-activity-body">
      <template v-if="item.type === 'tool'">
        <div v-if="item.progress" class="agent-tool-progress" role="status">
          {{ item.progress }}
        </div>
        <CodeViewer
          v-if="item.input != null"
          :value="item.input"
          :highlight="item.status !== 'running'"
          filename="input.json"
          language="json"
          :toolbar="false"
        />
        <CodeViewer
          v-if="item.output != null"
          :value="item.output"
          :highlight="item.status !== 'running'"
          filename="output.json"
          language="json"
          :toolbar="false"
        />
        <div v-if="item.error" class="agent-inline-error">
          {{ item.error }}
        </div>
      </template>

      <CodeViewer
        v-else-if="item.type === 'turn_diff'"
        :text="item.diff"
        :highlight="item.status !== 'running'"
        filename="turn.diff"
        language="diff"
        :toolbar="false"
      />

      <template v-else-if="item.type === 'file_change'">
        <div
          v-for="change in item.changes"
          :key="change.path + ':' + change.kind + ':' + (change.movePath ?? '')"
          class="agent-file-change"
        >
          <div class="agent-file-change-name">
            <v-chip size="x-small" variant="tonal">
              {{ change.kind }}
            </v-chip>
            <span class="mono">{{ change.path }}</span>
          </div>
          <CodeViewer
            v-if="change.diff"
            :text="change.diff"
            :filename="change.path"
            :highlight="item.status !== 'running'"
            language="diff"
            :toolbar="false"
          />
        </div>
      </template>

      <div v-else-if="item.type === 'plan'" class="agent-plan">
        <MarkdownContent
          v-if="item.text"
          :text="item.text"
          :streaming="item.status === 'running'"
        />
        <ol v-if="item.steps.length" class="agent-plan-steps">
          <li
            v-for="(step, index) in item.steps"
            :key="planStepKey(item, index)"
            :data-status="step.status"
          >
            <span class="agent-plan-step-text">{{ step.step }}</span>
            <span class="agent-plan-step-status">{{
              locale.t(`$vuetify.chatroom.agents.planStatuses.${step.status}`)
            }}</span>
          </li>
        </ol>
      </div>

      <template v-else-if="item.type === 'artifact'">
        <div class="agent-artifact-path mono">
          {{ item.artifact.path }}
        </div>
      </template>
    </div>
  </details>
</template>

<style scoped>
.agent-activity {
  min-inline-size: 0;
  max-inline-size: 100%;
  border-inline-start: 2px solid rgba(var(--v-border-color), 0.3);
  overflow-wrap: anywhere;
}
.agent-activity-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  list-style: none;
  font-size: 0.82rem;
  color: rgba(var(--v-theme-on-surface), 0.74);
}
.agent-activity-heading::-webkit-details-marker {
  display: none;
}
.agent-activity-heading:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}
.agent-activity-heading:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.agent-activity-title {
  flex: 1;
  min-inline-size: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-activity-chevron {
  flex-shrink: 0;
}
.agent-activity[open] .agent-activity-chevron {
  transform: rotate(90deg);
}
.agent-activity-body {
  min-inline-size: 0;
  padding: 0 10px 8px;
}
.agent-tool-progress,
.agent-inline-error {
  padding-block: 6px;
  white-space: pre-wrap;
}
.agent-inline-error {
  color: rgb(var(--v-theme-error));
}
.agent-file-change + .agent-file-change {
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.agent-file-change-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-block: 8px;
}
.agent-file-change-name span {
  min-inline-size: 0;
  overflow-wrap: anywhere;
}
.agent-plan-steps {
  padding-inline-start: 20px;
}
.agent-plan-steps li {
  padding-block: 4px;
}
.agent-plan-step-status {
  margin-inline-start: 8px;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.62);
}
.agent-plan-steps li[data-status="completed"] .agent-plan-step-status {
  color: rgb(var(--v-theme-success));
}
.agent-plan-steps li[data-status="inProgress"] .agent-plan-step-status {
  color: rgb(var(--v-theme-primary));
}
.agent-activity :deep(.code-viewer),
.agent-activity :deep(.code-viewer-plain) {
  min-inline-size: 0;
  max-inline-size: 100%;
}
.agent-activity :deep(.code-block) {
  max-block-size: 50dvh;
}
</style>
