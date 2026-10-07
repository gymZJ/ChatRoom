import { getCurrentScope, onScopeDispose } from "vue";

interface RequestToken {
  generation: number;
  signal: AbortSignal;
}

interface RequestGate {
  begin(): RequestToken;
  isCurrent(token: RequestToken): boolean;
  invalidate(): void;
}

export function createRequestGate(): RequestGate {
  let generation = 0;
  let controller: AbortController | null = null;
  let disposed = false;

  const gate: RequestGate = {
    begin() {
      controller?.abort();
      controller = new AbortController();
      generation += 1;
      if (disposed)
        controller.abort(new DOMException("Scope disposed", "AbortError"));
      return { generation, signal: controller.signal };
    },
    isCurrent(token) {
      return token.generation === generation && !token.signal.aborted;
    },
    invalidate() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };

  if (getCurrentScope())
    onScopeDispose(() => {
      disposed = true;
      gate.invalidate();
    });
  return gate;
}
