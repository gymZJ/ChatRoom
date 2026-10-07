import { onBeforeUnmount, shallowRef, watch, type ShallowRef } from "vue";

export function useAgentConversationScroll(
  conversation: Readonly<ShallowRef<HTMLElement | null>>,
  content: Readonly<ShallowRef<HTMLElement | null>>,
) {
  const autoFollow = shallowRef(true);
  let scrollFrame: number | null = null;
  let previousScrollTop = 0;

  function isNearBottom(threshold = 72): boolean {
    const element = conversation.value;
    return element
      ? element.scrollHeight - element.scrollTop - element.clientHeight <
          threshold
      : true;
  }

  function onConversationScroll() {
    const top = conversation.value?.scrollTop ?? 0;
    if (isNearBottom()) autoFollow.value = true;
    else if (top < previousScrollTop) autoFollow.value = false;
    previousScrollTop = top;
  }

  function scheduleScrollToBottom() {
    if (!autoFollow.value) return;
    if (scrollFrame !== null) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      const element = conversation.value;
      if (element && autoFollow.value) {
        element.scrollTop = element.scrollHeight;
        previousScrollTop = element.scrollTop;
      }
    });
  }

  function scrollToBottom() {
    autoFollow.value = true;
    scheduleScrollToBottom();
  }

  watch(
    [conversation, content],
    ([element, body], _previous, onCleanup) => {
      if (!element || !body) return;
      const observer = new ResizeObserver(() => scheduleScrollToBottom());
      observer.observe(element);
      observer.observe(body);
      scheduleScrollToBottom();
      onCleanup(() => {
        observer.disconnect();
      });
    },
    { flush: "post" },
  );

  onBeforeUnmount(() => {
    if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  });

  return {
    autoFollow,
    isNearBottom,
    onConversationScroll,
    scheduleScrollToBottom,
    scrollToBottom,
  };
}
