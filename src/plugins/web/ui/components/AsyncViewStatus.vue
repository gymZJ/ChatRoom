<script setup lang="ts">
import { useLocale } from "vuetify";
defineProps<{ error?: Error }>();
const locale = useLocale();
function reload() {
  window.location.reload();
}
</script>

<template>
  <div class="async-view-status" role="status">
    <v-alert v-if="error" type="error" variant="tonal">
      <div>{{ locale.t("$vuetify.chatroom.common.pageLoadFailed") }}</div>
      <v-btn
        class="mt-2"
        variant="text"
        prepend-icon="$mdiRefresh"
        @click="reload"
      >
        {{ locale.t("$vuetify.chatroom.common.reload") }}
      </v-btn>
    </v-alert>
    <v-progress-linear
      v-else
      indeterminate
      :aria-label="locale.t('$vuetify.chatroom.common.loading')"
    />
  </div>
</template>
