import { shallowRef, watch, type Ref, type ShallowRef } from "vue";

/**
 * Mirrors `source` into a ref that only updates after `delayMs` of quiet.
 * `set` updates both refs immediately (e.g. when clearing a search box).
 * The pending timer is cancelled with the owning effect scope.
 */
export function useDebouncedValue<T>(
  source: Ref<T>,
  delayMs: number,
): { debounced: ShallowRef<T>; set: (value: T) => void } {
  const debounced = shallowRef(source.value) as ShallowRef<T>;
  watch(source, (value, _previous, onCleanup) => {
    const timer = setTimeout(() => {
      debounced.value = value;
    }, delayMs);
    onCleanup(() => clearTimeout(timer));
  });
  return {
    debounced,
    set(value) {
      source.value = value;
      debounced.value = value;
    },
  };
}
