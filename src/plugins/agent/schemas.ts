import { z } from "zod";
import {
  AGENT_PERMISSION_MODES,
  AGENT_PROVIDER_ID_PATTERN,
  type AgentSessionConfig,
} from "./types.js";

/** Agent input schemas shared by the MCP tools and the WebUI HTTP API. */

export const providerIdSchema = z
  .string()
  .regex(AGENT_PROVIDER_ID_PATTERN)
  .describe("Registered Agent provider identifier.");

export const attachmentSchema = z.object({
  kind: z.enum(["image", "audio", "skill", "file"]),
  name: z.string(),
  path: z.string(),
  mimeType: z.string().nullable().default(null),
});

const granularApprovalPolicySchema = z.strictObject({
  granular: z.strictObject({
    sandbox_approval: z.boolean(),
    rules: z.boolean(),
    skill_approval: z.boolean(),
    request_permissions: z.boolean(),
    mcp_elicitations: z.boolean(),
  }),
});

const nonBlank = z.string().regex(/\S/, "must not be blank");

export const settingsSchemas = {
  model: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "Model identifier advertised by agent_models; null selects the provider default.",
    ),
  reasoningEffort: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "A reasoning effort advertised by the selected model; null uses its default.",
    ),
  reasoningSummary: z
    .enum(["auto", "concise", "detailed", "none"])
    .nullable()
    .describe(
      "A reasoning summary value supported by the provider/model; null uses its default.",
    ),
  serviceTier: z
    .string()
    .min(1)
    .nullable()
    .describe(
      "A service tier advertised by the selected model; null uses its default.",
    ),
  approvalPolicy: z
    .union([
      z.enum(["untrusted", "on-request", "never"]),
      granularApprovalPolicySchema,
    ])
    .nullable()
    .describe(
      'Codex approvalPolicy: "untrusted", "on-request", {granular:{...}}, "never", or null for the provider default.',
    ),
  approvalsReviewer: z
    .enum(["user", "auto_review", "guardian_subagent"])
    .nullable()
    .describe(
      'Codex approvalsReviewer: "user", "auto_review", "guardian_subagent", or null for the provider default.',
    ),
  permissionMode: z
    .enum(AGENT_PERMISSION_MODES)
    .nullable()
    .describe(
      "Provider-native permissions. Codex supports read-only, workspace-write, and danger-full-access (sandbox). Claude Code supports default, acceptEdits, plan, auto, dontAsk, and bypassPermissions. Null uses the provider default. Read agent_providers for supported options.",
    ),
};

/** Every setting optional: omitted keeps the current value, null resets it. */
export const settingsPatchShape = {
  model: settingsSchemas.model.optional(),
  reasoningEffort: settingsSchemas.reasoningEffort.optional(),
  reasoningSummary: settingsSchemas.reasoningSummary.optional(),
  serviceTier: settingsSchemas.serviceTier.optional(),
  approvalPolicy: settingsSchemas.approvalPolicy.optional(),
  approvalsReviewer: settingsSchemas.approvalsReviewer.optional(),
  permissionMode: settingsSchemas.permissionMode.optional(),
};

export const reviewTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("uncommittedChanges") }),
  z.strictObject({ type: z.literal("baseBranch"), branch: nonBlank }),
  z.strictObject({
    type: z.literal("commit"),
    sha: nonBlank,
    title: z.string().nullable().default(null),
  }),
  z.strictObject({ type: z.literal("custom"), instructions: nonBlank }),
]);

export const interactionResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approval"),
    decision: z.string().min(1),
  }),
  z.object({
    type: z.literal("input"),
    answers: z.record(z.string(), z.array(z.string())),
  }),
]);

/** Drops omitted (undefined) settings so they keep their current values. */
export function configurationPatch(input: {
  [Key in keyof AgentSessionConfig]?: AgentSessionConfig[Key] | undefined;
}): Partial<AgentSessionConfig> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => value !== undefined && key in settingsPatchShape,
    ),
  ) as Partial<AgentSessionConfig>;
}
