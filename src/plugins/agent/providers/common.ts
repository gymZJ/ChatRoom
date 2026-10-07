import type { AgentError, AgentInteractionOption } from "#plugins/agent/types";

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function record(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function questionOptions(value: unknown): AgentInteractionOption[] {
  return array(value)
    .map(record)
    .filter((option): option is Record<string, unknown> => Boolean(option))
    .map((option, index) => ({
      id: typeof option.label === "string" ? option.label : "option_" + index,
      label:
        typeof option.label === "string"
          ? option.label
          : "Option " + (index + 1),
      description:
        typeof option.description === "string" ? option.description : null,
    }));
}

export function stringifyOptional(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function continuityInstructions(context: string): string {
  return [
    "ChatRoom conversation continuity follows.",
    "This is prior conversation context from periods handled by another coding-agent provider in the same ChatRoom session.",
    "Treat it as authoritative prior conversation context alongside the current workspace state.",
    "Do not mention this continuity injection unless it is directly relevant to the user's request.",
    "",
    context,
  ].join("\n");
}

export function workspaceInstructions(prompt: string): string {
  return [
    "ChatRoom workspace preset instructions follow.",
    "These instructions are configured for the current workspace and apply to work performed in it.",
    "",
    prompt,
  ].join("\n");
}

export function combinedProviderInstructions(
  workspacePrompt: string | null,
  continuityContext: string | null,
): string | null {
  const sections: string[] = [];
  if (workspacePrompt) sections.push(workspaceInstructions(workspacePrompt));
  if (continuityContext)
    sections.push(continuityInstructions(continuityContext));
  return sections.length ? sections.join("\n\n") : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingExecutable(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function providerError(error: unknown): AgentError {
  return {
    message: errorMessage(error),
    details: null,
    providerData: null,
  };
}
