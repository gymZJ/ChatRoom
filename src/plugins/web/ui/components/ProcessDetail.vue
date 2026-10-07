<script setup lang="ts">
import { computed } from "vue";
import { useLocale } from "vuetify";
import type { ProcessSnapshot } from "../api.js";
import CodeViewer from "./CodeViewer.vue";
import StateChip from "./StateChip.vue";

const props = defineProps<{
  detail: ProcessSnapshot | null;
  output: string;
  compact: boolean;
}>();

defineEmits<{
  back: [];
  stop: [processId: string, force: boolean];
}>();

const locale = useLocale();
const fullCommand = computed(() =>
  props.detail
    ? [props.detail.command, ...props.detail.args]
        .map(formatCommandPart)
        .join(" ")
    : "",
);

function formatCommandPart(value: string): string {
  if (!value) return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
</script>

<template>
  <v-card v-if="detail" class="panel-card process-detail-card">
    <div class="panel-header process-detail-header">
      <v-btn
        v-if="compact"
        icon="$mdiArrowLeft"
        size="small"
        variant="text"
        :aria-label="locale.t('$vuetify.chatroom.processes.back')"
        @click="$emit('back')"
      />
      <div class="min-w-0 detail-header-title">
        <div class="panel-title text-truncate">{{ detail.command }}</div>
        <div class="panel-subtitle mono text-truncate">
          {{ detail.processId }}
        </div>
      </div>
      <div class="process-detail-actions">
        <StateChip v-if="detail.state !== 'running'" :value="detail.state" />
        <v-btn
          v-if="detail.state === 'running'"
          prepend-icon="$mdiStopCircleOutline"
          size="x-small"
          variant="tonal"
          color="warning"
          class="detail-action-btn"
          @click="$emit('stop', detail.processId, false)"
        >
          {{ locale.t("$vuetify.chatroom.processes.terminate") }}
        </v-btn>
        <v-menu v-if="detail.state === 'running'">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon="$mdiDotsHorizontal"
              size="x-small"
              variant="text"
              class="detail-icon-btn"
              :aria-label="locale.t('$vuetify.chatroom.processes.moreActions')"
            />
          </template>
          <v-list density="compact">
            <v-list-item
              :title="locale.t('$vuetify.chatroom.processes.kill')"
              prepend-icon="$mdiCloseOctagonOutline"
              @click="$emit('stop', detail.processId, true)"
            />
          </v-list>
        </v-menu>
      </div>
    </div>
    <v-divider />
    <div class="process-output">
      <CodeViewer
        :text="output"
        filename="output.txt"
        :highlight="detail.state !== 'running'"
      />
    </div>
    <v-divider />
    <div class="process-full-command">
      <div class="detail-section-label">
        {{ locale.t("$vuetify.chatroom.processes.fullCommand") }}
      </div>
      <CodeViewer
        :text="fullCommand"
        filename="command.sh"
        language="bash"
        :toolbar="false"
      />
    </div>
    <v-divider />
    <div class="detail-facts">
      <div>
        <span>{{ locale.t("$vuetify.chatroom.processes.pid") }}</span>
        <strong>{{ detail.pid ?? "—" }}</strong>
      </div>
      <div>
        <span>{{ locale.t("$vuetify.chatroom.processes.exit") }}</span>
        <strong>{{ detail.exitCode ?? "—" }}</strong>
      </div>
      <div>
        <span>{{ locale.t("$vuetify.chatroom.processes.timeout") }}</span>
        <strong>{{
          detail.timedOut
            ? locale.t("$vuetify.chatroom.processes.yes")
            : locale.t("$vuetify.chatroom.processes.no")
        }}</strong>
      </div>
    </div>
  </v-card>

  <v-card v-else class="panel-card">
    <div class="empty-panel">
      {{ locale.t("$vuetify.chatroom.processes.select") }}
    </div>
  </v-card>
</template>
