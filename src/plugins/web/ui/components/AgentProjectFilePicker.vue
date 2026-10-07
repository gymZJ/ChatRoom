<script setup lang="ts">
import { useLocale } from "vuetify";
import type { ProjectTreeRow } from "../utils/agent-files.js";

const props = defineProps<{
  rows: ProjectTreeRow[];
  truncated: boolean;
  selectedPaths: string[];
  expandedDirectories: ReadonlySet<string>;
  disabled: boolean;
}>();

const emit = defineEmits<{
  toggleDirectory: [path: string];
  toggleFile: [path: string];
}>();

const open = defineModel<boolean>("open", { required: true });
const search = defineModel<string>("search", { required: true });
const locale = useLocale();

function selected(path: string): boolean {
  return props.selectedPaths.includes(path);
}
</script>

<template>
  <v-menu
    v-model="open"
    :close-on-content-click="false"
    location="top start"
    offset="8"
    content-class="agent-overlay-menu"
  >
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        size="x-small"
        density="comfortable"
        variant="text"
        icon
        class="agent-compose-tool-button agent-workspace-reference-button"
        :disabled="disabled"
        :aria-label="locale.t('$vuetify.chatroom.agents.projectFiles')"
      >
        @
      </v-btn>
    </template>

    <v-card class="agent-file-picker" elevation="8">
      <div class="agent-file-picker-caption">
        {{ locale.t("$vuetify.chatroom.agents.projectFiles") }}
      </div>
      <v-text-field
        v-model="search"
        prepend-inner-icon="$mdiMagnify"
        :aria-label="locale.t('$vuetify.chatroom.agents.searchFiles')"
        :placeholder="locale.t('$vuetify.chatroom.agents.searchFiles')"
        density="compact"
        variant="outlined"
        hide-details
        autofocus
      />
      <v-alert
        v-if="truncated"
        type="warning"
        variant="tonal"
        density="compact"
        class="agent-project-files-truncated"
      >
        {{ locale.t("$vuetify.chatroom.agents.projectFilesTruncated") }}
      </v-alert>
      <div class="agent-file-picker-list">
        <button
          v-for="row in rows"
          :key="row.path"
          type="button"
          class="agent-tree-row"
          :data-type="row.type"
          :data-selected="
            row.type === 'file' && selected(row.path) ? 'true' : 'false'
          "
          :aria-expanded="
            row.type === 'directory'
              ? expandedDirectories.has(row.path)
              : undefined
          "
          :aria-pressed="row.type === 'file' ? selected(row.path) : undefined"
          :style="{
            paddingInlineStart: String(8 + row.depth * 18) + 'px',
          }"
          @click="
            row.type === 'directory'
              ? emit('toggleDirectory', row.path)
              : emit('toggleFile', row.path)
          "
        >
          <v-icon
            v-if="row.type === 'directory'"
            icon="$mdiChevronRight"
            size="16"
            class="agent-tree-chevron"
            :class="{
              'agent-tree-chevron-open': expandedDirectories.has(row.path),
            }"
          />
          <span v-else class="agent-tree-spacer" />
          <span class="agent-tree-name">{{ row.name }}</span>
          <span
            v-if="search.trim() && row.type === 'file'"
            class="agent-tree-path"
          >
            {{ row.path }}
          </span>
        </button>
        <div v-if="!rows.length" class="agent-file-picker-empty">
          {{ locale.t("$vuetify.chatroom.agents.noMatchingFiles") }}
        </div>
      </div>
    </v-card>
  </v-menu>
</template>

<style scoped>
.agent-compose-tool-button {
  padding: 0;
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.agent-workspace-reference-button {
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
  text-transform: none;
}

.agent-file-picker {
  inline-size: max-content;
  max-inline-size: 90vw;
  padding: 10px;
  background: rgb(var(--v-theme-surface));
  color: rgb(var(--v-theme-on-surface));
}

.agent-file-picker-caption,
.agent-tree-path {
  color: rgba(var(--v-theme-on-surface), 0.62);
}

.agent-file-picker-caption {
  margin-bottom: 9px;
  font-size: 0.75rem;
}

.agent-file-picker-list {
  max-height: 45dvh;
  overflow-y: auto;
  margin-top: 8px;
}

.agent-tree-row {
  width: 100%;
  min-height: 32px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 5px;
  padding-block: 4px;
  padding-inline-end: 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
}

.agent-tree-row:hover,
.agent-tree-row[data-selected="true"] {
  background: rgba(var(--v-theme-primary), 0.12);
}

.agent-tree-row[data-type="directory"] {
  font-weight: 600;
}

.agent-tree-chevron {
  transition: transform 120ms ease;
}

.agent-tree-chevron-open {
  transform: rotate(90deg);
}

.agent-tree-spacer {
  width: 16px;
}

.agent-tree-name {
  min-width: 0;
  overflow: hidden;
  font-size: 0.8rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-tree-path {
  max-width: 45%;
  overflow: hidden;
  font-family: var(--font-mono, monospace);
  font-size: 0.68rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-file-picker-empty {
  padding: 22px 10px;
  color: rgba(var(--v-theme-on-surface), 0.62);
  font-size: 0.8rem;
  text-align: center;
}

.agent-project-files-truncated {
  margin-top: 8px;
}
</style>
