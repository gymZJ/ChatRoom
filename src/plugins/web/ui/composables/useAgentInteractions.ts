import {
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";
import {
  api,
  type AgentInteractionResponse,
  type AgentItem,
  type AgentSession,
} from "../api.js";
import { errorMessage } from "../utils/errors.js";

type AgentInteractionItem = Extract<AgentItem, { type: "interaction" }>;

interface UseAgentInteractionsOptions {
  selectedId: Ref<string | null>;
  selected: ComputedRef<AgentSession | null>;
  error: Ref<string>;
  reconcileInteraction: (sessionId: string, item: AgentItem) => void;
}

export function useAgentInteractions(options: UseAgentInteractionsOptions) {
  const answerValues = shallowRef<Record<string, Record<string, string[]>>>({});
  const respondingInteractions = shallowRef<ReadonlySet<string>>(new Set());
  const requests = new Map<string, Set<string>>();
  let selectionGeneration = 0;

  watch(
    options.selectedId,
    () => {
      selectionGeneration += 1;
      answerValues.value = {};
      respondingInteractions.value = new Set(
        options.selectedId.value
          ? (requests.get(options.selectedId.value) ?? [])
          : [],
      );
    },
    { flush: "sync" },
  );

  onScopeDispose(() => requests.clear());

  async function respondApproval(item: AgentItem, decision: string) {
    if (item.type !== "interaction" || !options.selected.value) return;
    await respond(item, { type: "approval", decision });
  }

  async function submitInput(item: AgentItem) {
    if (item.type !== "interaction" || !options.selected.value) return;
    const answers: Record<string, string[]> = {};
    for (const question of item.interaction.questions) {
      const values = interactionAnswers(item)[question.id] ?? [];
      answers[question.id] = question.multiSelect ? values : values.slice(0, 1);
    }
    await respond(item, { type: "input", answers });
  }

  async function respond(
    item: AgentInteractionItem,
    response: AgentInteractionResponse,
  ) {
    const session = options.selected.value;
    const activeRequests = session ? requests.get(session.id) : undefined;
    if (!session || item.status !== "waiting" || activeRequests?.has(item.id))
      return;

    const token = { sessionId: session.id, generation: selectionGeneration };
    const responding = new Set(activeRequests ?? []);
    responding.add(item.id);
    requests.set(session.id, responding);
    respondingInteractions.value = new Set(responding);
    options.error.value = "";

    try {
      const updated = await api<AgentItem>(
        "/agents/sessions/" +
          encodeURIComponent(session.id) +
          "/interactions/" +
          encodeURIComponent(item.id),
        { method: "POST", body: JSON.stringify(response) },
      );
      options.reconcileInteraction(session.id, updated);
    } catch (cause) {
      if (selectionIsCurrent(token)) options.error.value = errorMessage(cause);
    } finally {
      const next = new Set(requests.get(session.id) ?? []);
      next.delete(item.id);
      if (next.size) requests.set(session.id, next);
      else requests.delete(session.id);
      if (options.selectedId.value === session.id)
        respondingInteractions.value = next;
    }
  }

  const emptyAnswers: Record<string, string[]> = Object.freeze({});

  function interactionAnswers(
    item: AgentInteractionItem,
  ): Record<string, string[]> {
    return answerValues.value[item.id] ?? emptyAnswers;
  }

  function setInteractionAnswer(
    item: AgentInteractionItem,
    questionId: string,
    values: string[],
  ) {
    answerValues.value = {
      ...answerValues.value,
      [item.id]: {
        ...(answerValues.value[item.id] ?? {}),
        [questionId]: values,
      },
    };
  }

  function selectionIsCurrent(token: {
    sessionId: string;
    generation: number;
  }): boolean {
    return (
      options.selectedId.value === token.sessionId &&
      selectionGeneration === token.generation
    );
  }

  return {
    respondingInteractions,
    respondApproval,
    submitInput,
    interactionAnswers,
    setInteractionAnswer,
  };
}
