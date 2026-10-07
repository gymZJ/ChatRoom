<script setup lang="ts">
import { computed } from "vue";
import { useLocale } from "vuetify";
import type { AgentItem } from "../api.js";

type InteractionItem = Extract<AgentItem, { type: "interaction" }>;

const props = withDefaults(
  defineProps<{
    item: InteractionItem;
    answers?: Record<string, string[]>;
    pinned?: boolean;
    responding?: boolean;
  }>(),
  {
    answers: () => ({}),
    pinned: false,
    responding: false,
  },
);
const emit = defineEmits<{
  approve: [decision: string];
  submit: [];
  "update-answer": [questionId: string, values: string[]];
}>();
const locale = useLocale();

const optionItems = computed(() =>
  Object.fromEntries(
    props.item.interaction.questions.map((question) => [
      question.id,
      question.options.map((option) => ({
        title: option.label,
        value: option.id,
      })),
    ]),
  ),
);

const primaryOptions = computed(() => {
  const options = props.item.interaction.approvalOptions;
  const first = options[0];
  const deny = options.find(
    (option) => option.id === "decline" || option.id === "deny",
  );
  const result = first ? [first] : [];
  if (deny && deny !== first) result.push(deny);
  return result;
});
const moreOptions = computed(() =>
  props.item.interaction.approvalOptions.filter(
    (option) => !primaryOptions.value.includes(option),
  ),
);

const approvalKeys: Record<string, string> = {
  accept: "accept",
  allow: "accept",
  acceptForSession: "session",
  decline: "deny",
  deny: "deny",
  cancel: "cancel",
  acceptWithExecpolicyAmendment: "similar",
};
function approvalLabel(id: string, fallback: string): string {
  const key = approvalKeys[id];
  return key
    ? locale.t("$vuetify.chatroom.agents.approvalChoices." + key)
    : fallback;
}
function approvalIcon(id: string): string {
  return id === "cancel"
    ? "$mdiStopCircleOutline"
    : id === "decline" || id === "deny"
      ? "$mdiCloseOctagonOutline"
      : "$mdiCheckCircleOutline";
}
const resolvedText = computed(() => {
  const response = props.item.interaction.response;
  if (!response)
    return locale.t(
      props.item.status === "completed"
        ? "$vuetify.chatroom.agents.resolvedExternally"
        : "$vuetify.chatroom.agents.statuses." + props.item.status,
    );
  if (response.type === "approval") {
    const choice = props.item.interaction.approvalOptions.find(
      (option) => option.id === response.decision,
    );
    return approvalLabel(response.decision, choice?.label ?? response.decision);
  }
  return props.item.interaction.questions
    .map(
      (question) =>
        question.label +
        ": " +
        (question.secret
          ? "••••"
          : (response.answers[question.id] ?? []).join(", ")),
    )
    .join("\n");
});

function answer(questionId: string): string[] {
  return props.answers[questionId] ?? [];
}

function normalizeAnswer(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" && value ? [value] : [];
}

function setAnswer(questionId: string, value: unknown) {
  emit("update-answer", questionId, normalizeAnswer(value));
}
</script>

<template>
  <section
    class="agent-interaction-card"
    :class="{ 'agent-interaction-card--pinned': pinned }"
    :aria-label="item.interaction.title"
    :aria-busy="responding"
  >
    <header class="agent-interaction-heading">
      <v-icon
        :icon="
          item.status === 'completed'
            ? '$mdiCheckCircleOutline'
            : '$mdiAlertCircleOutline'
        "
        size="18"
      />
      <span>{{
        locale.t(
          item.status === "waiting"
            ? item.interaction.kind === "approval"
              ? "$vuetify.chatroom.agents.waitingApproval"
              : "$vuetify.chatroom.agents.waitingAnswer"
            : item.status === "completed"
              ? "$vuetify.chatroom.agents.interactionResolved"
              : "$vuetify.chatroom.agents.statuses." + item.status,
        )
      }}</span>
      <v-progress-circular
        v-if="responding"
        indeterminate
        size="15"
        width="2"
      />
    </header>
    <div class="agent-interaction-content">
      <div class="agent-interaction-title">{{ item.interaction.title }}</div>
      <pre
        v-if="item.interaction.description"
        class="agent-interaction-description"
        :class="{ mono: item.interaction.kind === 'approval' }"
        >{{ item.interaction.description }}</pre>

      <div v-if="item.status === 'waiting'">
        <div
          v-if="item.interaction.kind !== 'approval'"
          class="agent-input-questions"
        >
          <div
            v-for="question in item.interaction.questions"
            :key="question.id"
            class="agent-question"
          >
            <div class="agent-question-label">{{ question.label }}</div>
            <div class="agent-question-text">{{ question.question }}</div>

            <v-combobox
              v-if="question.options.length && question.allowFreeText"
              :model-value="
                question.multiSelect
                  ? answer(question.id)
                  : (answer(question.id)[0] ?? null)
              "
              :items="optionItems[question.id] ?? []"
              :aria-label="question.label + ': ' + question.question"
              :return-object="false"
              :multiple="question.multiSelect"
              :chips="question.multiSelect"
              :closable-chips="question.multiSelect"
              density="compact"
              hide-details
              :disabled="responding"
              @update:model-value="setAnswer(question.id, $event)"
            />
            <v-select
              v-else-if="question.options.length"
              :model-value="
                question.multiSelect
                  ? answer(question.id)
                  : (answer(question.id)[0] ?? null)
              "
              :items="optionItems[question.id] ?? []"
              :aria-label="question.label + ': ' + question.question"
              :return-object="false"
              :multiple="question.multiSelect"
              :chips="question.multiSelect"
              :closable-chips="question.multiSelect"
              density="compact"
              hide-details
              :disabled="responding"
              @update:model-value="setAnswer(question.id, $event)"
            />
            <v-text-field
              v-else
              :model-value="answer(question.id)[0] ?? ''"
              :type="question.secret ? 'password' : 'text'"
              :aria-label="question.label + ': ' + question.question"
              density="compact"
              hide-details
              :disabled="responding"
              @update:model-value="setAnswer(question.id, $event)"
            />
          </div>
        </div>
      </div>

      <div v-else class="agent-interaction-resolved">{{ resolvedText }}</div>
    </div>
    <footer v-if="item.status === 'waiting'" class="agent-interaction-footer">
      <div
        v-if="item.interaction.kind === 'approval'"
        class="agent-interaction-actions"
      >
        <v-btn
          v-for="option in primaryOptions"
          :key="option.id"
          :color="
            option.id === 'decline' ||
            option.id === 'deny' ||
            option.id === 'cancel'
              ? 'error'
              : 'primary'
          "
          :prepend-icon="approvalIcon(option.id)"
          variant="tonal"
          size="small"
          :title="option.description ?? undefined"
          :disabled="responding"
          @click="emit('approve', option.id)"
        >
          {{ approvalLabel(option.id, option.label) }}
        </v-btn>
        <v-menu v-if="moreOptions.length" location="top end" offset="8">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon="$mdiDotsHorizontal"
              size="small"
              variant="text"
              :disabled="responding"
              :aria-label="
                locale.t('$vuetify.chatroom.agents.moreApprovalOptions')
              "
              :title="locale.t('$vuetify.chatroom.agents.moreApprovalOptions')"
            />
          </template>
          <v-list density="compact" class="agent-approval-more-menu">
            <v-list-item
              v-for="option in moreOptions"
              :key="option.id"
              :title="approvalLabel(option.id, option.label)"
              :subtitle="option.description ?? ''"
              :prepend-icon="approvalIcon(option.id)"
              :disabled="responding"
              @click="emit('approve', option.id)"
            />
          </v-list>
        </v-menu>
      </div>

      <v-btn
        v-if="item.interaction.kind !== 'approval'"
        color="primary"
        variant="tonal"
        size="small"
        :loading="responding"
        :disabled="responding"
        @click="emit('submit')"
      >
        {{ locale.t("$vuetify.chatroom.agents.submit") }}
      </v-btn>
    </footer>
  </section>
</template>

<style scoped>
.agent-interaction-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-inline-size: 0;
  max-inline-size: 100%;
  min-block-size: min-content;
  border-block: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  flex: 1 1 0;
  overflow-wrap: anywhere;
}

.agent-interaction-content {
  min-inline-size: 0;
  min-block-size: 0;
  flex: 1 1 auto;
  padding: 10px 12px;
  overflow: auto;
  overscroll-behavior: contain;
}

.agent-interaction-footer {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  border-block-start: 1px solid
    rgba(var(--v-border-color), var(--v-border-opacity));
}

.agent-interaction-footer :deep(.v-btn) {
  max-inline-size: 100%;
  height: auto;
  padding: 0.5em 0.75em;
  white-space: normal;
}

.agent-interaction-footer :deep(.v-btn__content) {
  white-space: normal;
  overflow-wrap: anywhere;
}

.agent-interaction-card--pinned .agent-interaction-content {
  contain: size;
}

.agent-interaction-card--pinned {
  background: rgb(var(--v-theme-surface));
  border-color: rgba(var(--v-theme-warning), 0.42);
}

.agent-interaction-heading {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 0.85rem;
  font-weight: 600;
}
.agent-interaction-title {
  overflow-wrap: anywhere;
  font-weight: 600;
  margin-block-end: 6px;
}
.agent-interaction-description {
  margin: 0 0 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.8rem;
}
.agent-interaction-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  inline-size: 100%;
}
.agent-interaction-actions > :deep(.v-btn:not(.v-btn--icon)) {
  flex: 1 1 auto;
}
.agent-approval-more-menu {
  max-inline-size: 90vw;
}
.agent-approval-more-menu :deep(.v-list-item-subtitle) {
  overflow-wrap: anywhere;
}
.agent-interaction-actions :deep(.v-btn__content) {
  min-inline-size: 0;
  line-height: 1.4;
}

.agent-input-questions,
.agent-question {
  display: grid;
}

.agent-input-questions {
  gap: 14px;
}

.agent-question {
  min-width: 0;
  gap: 6px;
}

.agent-question-label {
  font-weight: 600;
}

.agent-question-text,
.agent-interaction-resolved {
  color: rgba(var(--v-theme-on-surface), 0.62);
}

.agent-question-text {
  font-size: 0.875rem;
}

.agent-interaction-resolved {
  white-space: pre-wrap;
}
</style>
