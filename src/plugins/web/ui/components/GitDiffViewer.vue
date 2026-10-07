<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { useLocale } from "vuetify";

const INITIAL_ROWS = 500;
const ROW_CHUNK = 500;
const MAX_RENDERED_ROWS = 2500;
const props = defineProps<{ text: string }>();
const locale = useLocale();
const visibleLimit = shallowRef(INITIAL_ROWS);

interface DiffRow {
  key: string;
  text: string;
  kind: "meta" | "hunk" | "add" | "delete" | "context";
  oldLine: number | null;
  newLine: number | null;
}

watch(
  () => props.text,
  () => {
    visibleLimit.value = INITIAL_ROWS;
  },
);

const sourceLineCount = computed(() => countLines(props.text));
const rows = computed<DiffRow[]>(() =>
  parseDiff(props.text, Math.min(visibleLimit.value, MAX_RENDERED_ROWS)),
);
const hiddenRows = computed(() =>
  Math.max(0, sourceLineCount.value - rows.value.length),
);
const canShowMore = computed(
  () => rows.value.length < Math.min(sourceLineCount.value, MAX_RENDERED_ROWS),
);
const renderLimitReached = computed(
  () =>
    sourceLineCount.value > MAX_RENDERED_ROWS &&
    rows.value.length >= MAX_RENDERED_ROWS,
);

function showMore() {
  visibleLimit.value = Math.min(
    MAX_RENDERED_ROWS,
    visibleLimit.value + ROW_CHUNK,
  );
}

function parseDiff(text: string, maxRows: number): DiffRow[] {
  const result: DiffRow[] = [];
  const keyCounts = new Map<string, number>();
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunkIdentity = "header";

  const push = (
    line: string,
    kind: DiffRow["kind"],
    oldValue: number | null,
    newValue: number | null,
  ) => {
    const base =
      hunkIdentity +
      ":" +
      kind +
      ":" +
      (oldValue ?? "-") +
      ":" +
      (newValue ?? "-") +
      ":" +
      hashLine(line);
    const occurrence = keyCounts.get(base) ?? 0;
    keyCounts.set(base, occurrence + 1);
    result.push({
      key: base + ":" + occurrence,
      text: line,
      kind,
      oldLine: oldValue,
      newLine: newValue,
    });
  };

  for (const line of text.split("\n", maxRows)) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      hunkIdentity = line;
      push(line, "hunk", null, null);
      continue;
    }

    if (
      !inHunk ||
      line.startsWith("diff --git ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode ") ||
      line.startsWith("deleted file mode ") ||
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch") ||
      line.startsWith("\\ No newline")
    ) {
      if (line.startsWith("diff --git ")) hunkIdentity = line;
      push(line, "meta", null, null);
      continue;
    }

    if (line.startsWith("+")) {
      push(line, "add", null, newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      push(line, "delete", oldLine, null);
      oldLine += 1;
    } else {
      push(line, "context", oldLine, newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return result;
}

function countLines(text: string): number {
  if (!text) return 1;
  let count = 1;
  for (let index = 0; index < text.length; index += 1)
    if (text.charCodeAt(index) === 10) count += 1;
  return count;
}

function hashLine(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
</script>

<template>
  <div class="git-diff-viewer">
    <div class="git-diff-content">
      <div
        v-for="row in rows"
        :key="row.key"
        class="git-diff-row"
        :class="`git-diff-row-${row.kind}`"
      >
        <span class="git-diff-line-number">{{ row.oldLine ?? "" }}</span>
        <span class="git-diff-line-number">{{ row.newLine ?? "" }}</span>
        <code class="git-diff-line">{{ row.text }}</code>
      </div>
    </div>
    <div v-if="hiddenRows" class="git-diff-expand">
      <span>
        {{
          locale.t("$vuetify.chatroom.git.diffRowsHidden", String(hiddenRows))
        }}
      </span>
      <v-btn v-if="canShowMore" size="small" variant="text" @click="showMore">
        {{ locale.t("$vuetify.chatroom.git.showMoreDiff") }}
      </v-btn>
      <span v-else-if="renderLimitReached">
        {{ locale.t("$vuetify.chatroom.git.diffRenderLimit") }}
      </span>
    </div>
  </div>
</template>
