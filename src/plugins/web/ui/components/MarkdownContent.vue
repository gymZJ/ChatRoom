<script setup lang="ts">
import { computed } from "vue";
import { renderMarkdown } from "../utils/markdown.js";

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
  }>(),
  { streaming: false },
);

const rendered = computed(() =>
  props.streaming ? "" : renderMarkdown(props.text),
);
</script>

<template>
  <div v-if="streaming" class="markdown-content markdown-content-streaming">
    {{ text }}
  </div>
  <div v-else class="markdown-content" v-html="rendered" />
</template>

<style scoped>
.markdown-content {
  min-width: 0;
  overflow-wrap: anywhere;
  line-height: 1.6;
}

.markdown-content-streaming {
  white-space: pre-wrap;
}

.markdown-content :deep(> :first-child) {
  margin-top: 0;
}

.markdown-content :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(p) {
  margin: 0 0 0.72em;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  margin: 1em 0 0.45em;
  font-weight: 650;
  line-height: 1.3;
}

.markdown-content :deep(h1) {
  font-size: 1.32rem;
}

.markdown-content :deep(h2) {
  font-size: 1.18rem;
}

.markdown-content :deep(h3) {
  font-size: 1.06rem;
}

.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  font-size: 0.98rem;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  margin: 0.45em 0 0.75em;
  padding-inline-start: 1.45rem;
}

.markdown-content :deep(li + li) {
  margin-top: 0.22em;
}

.markdown-content :deep(a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
}

.markdown-content :deep(a:hover) {
  text-decoration: underline;
}

.markdown-content :deep(code:not(pre code)) {
  padding: 0.12em 0.38em;
  border: 1px solid rgba(var(--v-border-color), 0.22);
  border-radius: 5px;
  background: rgba(var(--v-theme-on-surface), 0.07);
  font:
    0.88em/1.45 "SFMono-Regular",
    Consolas,
    "Liberation Mono",
    monospace;
}

.markdown-content :deep(.markdown-code-block) {
  margin: 0.72em 0;
  padding: 12px 14px;
  overflow: auto;
  border: 1px solid rgba(var(--v-border-color), 0.24);
  border-radius: 9px;
  background: rgba(var(--v-theme-surface-variant), 0.18);
  font:
    12px/1.6 "SFMono-Regular",
    Consolas,
    "Liberation Mono",
    monospace;
  white-space: pre;
}

.markdown-content :deep(.markdown-code-block code) {
  font: inherit;
}

.markdown-content :deep(blockquote) {
  margin: 0.72em 0;
  padding: 0.12em 0 0.12em 0.9em;
  border-inline-start: 3px solid rgba(var(--v-theme-primary), 0.5);
  color: rgba(var(--v-theme-on-surface), 0.72);
}

.markdown-content :deep(hr) {
  margin: 1em 0;
  border: 0;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.markdown-content :deep(table) {
  display: block;
  max-width: 100%;
  margin: 0.72em 0;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.92em;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 6px 9px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  text-align: start;
  white-space: nowrap;
}

.markdown-content :deep(th) {
  background: rgba(var(--v-theme-on-surface), 0.055);
  font-weight: 600;
}

.markdown-content :deep(img) {
  display: block;
  max-width: 100%;
  margin: 0.72em 0;
  border-radius: 8px;
  object-fit: contain;
}
</style>
