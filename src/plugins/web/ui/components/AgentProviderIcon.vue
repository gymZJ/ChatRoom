<script setup lang="ts">
import { computed } from "vue";
import { siOpenai } from "simple-icons";

const props = withDefaults(
  defineProps<{
    icon?: string | null;
    size?: number;
  }>(),
  { icon: null, size: 16 },
);

const iconPaths: Record<string, string> = {
  openai: siOpenai.path,
};

const path = computed(() =>
  props.icon ? (iconPaths[props.icon] ?? null) : null,
);
</script>

<template>
  <svg
    class="agent-provider-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path v-if="path" :d="path" fill="currentColor" />
    <g v-else fill="none" stroke="currentColor" stroke-width="1.8">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 16 3.5-8 3.5 8M10 13h4" />
    </g>
  </svg>
</template>

<style scoped>
.agent-provider-icon {
  display: block;
  flex: 0 0 auto;
}
</style>
