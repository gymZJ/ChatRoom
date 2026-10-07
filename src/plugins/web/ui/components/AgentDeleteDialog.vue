<script setup lang="ts">
import { useLocale } from "vuetify";

defineProps<{ busy?: boolean }>();
defineEmits<{ confirm: [] }>();
const open = defineModel<boolean>({ required: true });
const locale = useLocale();
</script>

<template>
  <v-dialog
    v-model="open"
    max-width="90vw"
    :persistent="busy"
    content-class="agent-overlay-dialog"
  >
    <v-card>
      <v-card-title>
        {{ locale.t("$vuetify.chatroom.agents.deleteTitle") }}
      </v-card-title>
      <v-card-text>
        {{ locale.t("$vuetify.chatroom.agents.deleteDescription") }}
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" :disabled="busy" @click="open = false">
          {{ locale.t("$vuetify.chatroom.common.cancel") }}
        </v-btn>
        <v-btn
          color="error"
          variant="tonal"
          :loading="busy"
          @click="$emit('confirm')"
        >
          {{ locale.t("$vuetify.chatroom.agents.delete") }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
