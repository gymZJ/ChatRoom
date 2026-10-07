import { nextTick, useTemplateRef, type Ref } from "vue";

export function useMasterDetailFocus(compact: Readonly<Ref<boolean>>) {
  const layout = useTemplateRef<HTMLElement>("layout");
  const detailPane = useTemplateRef<HTMLElement>("detailPane");

  function focusDetail() {
    if (!compact.value) return;
    void nextTick(() => {
      layout.value?.scrollIntoView({ behavior: "smooth", block: "start" });
      detailPane.value?.focus({ preventScroll: true });
    });
  }

  function focusMaster(selector: string) {
    if (!compact.value) return;
    void nextTick(() => {
      layout.value
        ?.querySelector<HTMLElement>(selector)
        ?.focus({ preventScroll: true });
    });
  }

  return { focusDetail, focusMaster };
}
