import { z } from "zod";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { PluginMcpRegistrar } from "#mcp/server/plugin-mcp-registrar";
import {
  closedRead,
  destructiveLocalMutation,
  openWorldMutation,
} from "#mcp/server/tool-support";
import type { AgentRuntime } from "./runtime.js";
import type { AgentHistoryPage } from "./types.js";
import {
  attachmentSchema,
  configurationPatch,
  interactionResponseSchema,
  providerIdSchema,
  reviewTargetSchema,
  settingsPatchShape,
  settingsSchemas,
} from "./schemas.js";

const provider = providerIdSchema;
const attachment = attachmentSchema;
const interactionResponse = interactionResponseSchema;
const settings = settingsSchemas;

const tokenUsageBreakdown = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

const tokenUsage = z.object({
  total: tokenUsageBreakdown,
  last: tokenUsageBreakdown,
  modelContextWindow: z.number().nullable(),
});

const capabilities = z
  .object({
    namespaceTools: z.boolean(),
    imageGeneration: z.boolean(),
    webSearch: z.boolean(),
  })
  .catchall(z.boolean())
  .nullable();

const session = z.object({
  id: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  provider,
  ...settings,
  tokenUsage: tokenUsage.nullable(),
  status: z.enum(["idle", "running", "waiting_input", "error"]),
  attention: z
    .object({
      kind: z.enum(["approval", "input"]),
      count: z.number().int().positive(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const turn = z.object({
  id: z.string(),
  sessionId: z.string(),
  providerTurnId: z.string().nullable(),
  provider,
  ...settings,
  source: z.enum(["human", "mcp"]),
  status: z.enum(["running", "completed", "interrupted", "failed"]),
  usage: tokenUsageBreakdown.nullable(),
  error: z
    .object({
      message: z.string(),
      details: z.string().nullable(),
      providerData: z.unknown().nullable(),
    })
    .nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

const interactionOption = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
});

const itemBase = z.object({
  id: z.string(),
  turnId: z.string(),
  providerItemId: z.string().nullable(),
  sequence: z.number(),
  status: z.enum(["running", "completed", "waiting", "interrupted", "failed"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const item = z.discriminatedUnion("type", [
  itemBase.extend({
    type: z.literal("user_message"),
    source: z.enum(["human", "mcp"]).optional(),
    text: z.string(),
    attachments: z.array(attachment),
  }),
  itemBase.extend({
    type: z.literal("assistant_message"),
    text: z.string(),
    phase: z.enum(["commentary", "final_answer"]).nullable(),
  }),
  itemBase.extend({
    type: z.literal("command"),
    command: z.string(),
    cwd: z.string().nullable(),
    output: z.string(),
    exitCode: z.number().nullable(),
  }),
  itemBase.extend({
    type: z.literal("tool"),
    progress: z.string().nullable(),
    name: z.string(),
    server: z.string().nullable(),
    input: z.unknown(),
    output: z.unknown(),
    error: z.string().nullable(),
  }),
  itemBase.extend({ type: z.literal("turn_diff"), diff: z.string() }),
  itemBase.extend({
    type: z.literal("file_change"),
    changes: z.array(
      z.object({
        path: z.string(),
        kind: z.string(),
        movePath: z.string().nullable(),
        diff: z.string(),
      }),
    ),
  }),
  itemBase.extend({
    type: z.literal("plan"),
    text: z.string(),
    steps: z.array(
      z.object({
        step: z.string(),
        status: z.enum(["pending", "inProgress", "completed"]),
      }),
    ),
  }),
  itemBase.extend({ type: z.literal("reasoning_summary"), text: z.string() }),
  itemBase.extend({
    type: z.literal("artifact"),
    artifact: attachment.extend({ kind: z.enum(["image", "file"]) }),
  }),
  itemBase.extend({
    type: z.literal("interaction"),
    interaction: z.object({
      kind: z.enum(["approval", "input"]),
      title: z.string(),
      description: z.string().nullable(),
      questions: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          question: z.string(),
          options: z.array(interactionOption),
          multiSelect: z.boolean(),
          allowFreeText: z.boolean(),
          secret: z.boolean(),
        }),
      ),
      approvalOptions: z.array(interactionOption),
      response: interactionResponse.nullable(),
    }),
  }),
  itemBase.extend({
    type: z.literal("notice"),
    level: z.enum(["info", "warning", "error"]),
    text: z.string(),
  }),
]);

export function registerAgentTools(
  mcp: PluginMcpRegistrar,
  agents: AgentRuntime,
): void {
  mcp.registerTool(
    "agent_providers",
    {
      title: "List Agent providers",
      description:
        "List registered Agent providers, availability, authentication state, runtime version, declared features, provider capabilities, and exact provider-native permission settings. Capabilities are null when unavailable.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        providers: z.array(
          z.object({
            id: provider,
            displayName: z.string(),
            icon: z.string().nullable(),
            features: z
              .object({
                nativeReview: z.boolean(),
                steering: z.boolean(),
              })
              .catchall(z.boolean()),
            nativeSettings: z.array(
              z.object({
                id: z.enum([
                  "approvalPolicy",
                  "approvalsReviewer",
                  "permissionMode",
                ]),
                defaultValue: z.string(),
                options: z.array(
                  z.object({
                    id: z.string(),
                    description: z.string().nullable(),
                  }),
                ),
                granularFields: z.array(
                  z.object({
                    id: z.string(),
                    description: z.string().nullable(),
                  }),
                ),
              }),
            ),
            installed: z.boolean(),
            authenticated: z.boolean(),
            version: z.string().nullable(),
            error: z.string().nullable(),
            capabilities,
          }),
        ),
      }),
      annotations: closedRead,
      action: "providers",
    },
    async () => ({ providers: await agents.providerStatuses() }),
  );

  mcp.registerTool(
    "agent_provider_details",
    {
      title: "Read Agent provider details",
      description:
        "Read provider-owned configuration requirements and rate limits. Each field is nullable provider-owned JSON; null means unavailable.",
      inputSchema: z.object({ provider }),
      outputSchema: z.object({
        configRequirements: z.unknown().nullable(),
        rateLimits: z.unknown().nullable(),
        accountUsage: z
          .object({
            subscriptionType: z.string().nullable(),
            windows: z.array(
              z.object({
                id: z.string(),
                label: z.string().nullable(),
                utilization: z.number().nullable(),
                resetsAt: z.string().nullable(),
              }),
            ),
            extraUsage: z
              .object({
                enabled: z.boolean(),
                monthlyLimit: z.number().nullable(),
                usedCredits: z.number().nullable(),
                utilization: z.number().nullable(),
                currency: z.string().nullable(),
              })
              .nullable(),
            updatedAt: z.string(),
          })
          .nullable(),
      }),
      annotations: closedRead,
      action: "provider_details",
    },
    ({ provider }) => agents.providerDetails(provider),
  );

  mcp.registerTool(
    "agent_models",
    {
      title: "List Agent models",
      description:
        "List provider models with advertised reasoning efforts, input modalities, service tiers, defaults, and upgrade metadata. Select supported settings from this catalog and check agent_providers capabilities before configuring a session.",
      inputSchema: z.object({ provider }),
      outputSchema: z.object({
        models: z.array(
          z.object({
            id: z.string(),
            model: z.string(),
            displayName: z.string(),
            description: z.string(),
            modelSpecialty: z.string().nullable(),
            isDefault: z.boolean(),
            upgrade: z.string().nullable(),
            upgradeInfo: z.unknown().nullable(),
            availabilityMessage: z.string().nullable(),
            reasoningEfforts: z.array(
              z.object({ id: z.string(), description: z.string() }),
            ),
            defaultReasoningEffort: z.string().nullable(),
            reasoningSummaries: z.array(
              z.enum(["auto", "concise", "detailed", "none"]),
            ),
            defaultReasoningSummary: z
              .enum(["auto", "concise", "detailed", "none"])
              .nullable(),
            inputModalities: z.array(z.enum(["text", "image", "audio"])),
            multiAgentVersion: z.string().nullable(),
            serviceTiers: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                description: z.string(),
              }),
            ),
            defaultServiceTier: z.string().nullable(),
            availableAccessPrograms: z
              .object({
                cyber: z.array(z.string()),
              })
              .catchall(z.array(z.string()))
              .nullable(),
          }),
        ),
      }),
      annotations: closedRead,
      action: "models",
    },
    async ({ provider }) => ({ models: await agents.models(provider) }),
  );

  mcp.registerTool(
    "agent_sessions",
    {
      title: "List Agent sessions",
      description: "List ChatRoom Agent sessions shared by MCP and the Web UI.",
      inputSchema: z.object({}),
      outputSchema: z.object({ sessions: z.array(session) }),
      annotations: closedRead,
      action: "sessions",
    },
    () => ({ sessions: agents.listSessions() }),
  );

  mcp.registerTool(
    "agent_create",
    {
      title: "Create Agent session",
      description:
        "Create an Agent session for a ChatRoom workspace using a registered provider. Choose settings from agent_models and agent_providers capabilities; omitted or null settings use provider/model defaults.",
      inputSchema: z.object({
        workspaceId: z.string().min(1),
        provider,
        model: settings.model.default(null),
        reasoningEffort: settings.reasoningEffort.default(null),
        reasoningSummary: settings.reasoningSummary.default(null),
        serviceTier: settings.serviceTier.default(null),
        approvalPolicy: settings.approvalPolicy.default(null),
        approvalsReviewer: settings.approvalsReviewer.default(null),
        permissionMode: settings.permissionMode.default(null),
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "create",
    },
    (input) => agents.createSession(input),
  );

  mcp.registerTool(
    "agent_send",
    {
      title: "Send Agent instruction",
      description:
        "Send an instruction to an existing Agent session. The turn is recorded as source=mcp and appears in the same Web UI conversation as human turns. Returns after the turn is started; use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        text: z.string().default(""),
        attachments: z.array(attachment).default([]),
        outputSchema: z
          .unknown()
          .nullable()
          .default(null)
          .describe(
            "Provider-supported JSON schema constraining the final response for this turn; omitted or null requests no output constraint.",
          ),
      }),
      outputSchema: turn,
      annotations: openWorldMutation,
      action: "send",
    },
    (input) =>
      agents.startTurn(
        input.sessionId,
        {
          text: input.text,
          attachments: input.attachments,
          outputSchema: input.outputSchema,
        },
        "mcp",
      ),
  );

  mcp.registerTool(
    "agent_steer",
    {
      title: "Steer active Agent turn",
      description:
        "Steer the currently active turn with text and attachments. Requires an active turn and accepts no configuration override. Use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        text: z.string().default(""),
        attachments: z.array(attachment).default([]),
      }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: openWorldMutation,
      action: "steer",
    },
    async ({ sessionId, text, attachments }) => {
      await agents.steer(
        sessionId,
        {
          text,
          attachments,
        },
        "mcp",
      );
      return { ok: true as const };
    },
  );

  mcp.registerTool(
    "agent_review",
    {
      title: "Start Agent review",
      description:
        "Start an inline review in the existing Agent conversation for uncommitted changes, a base branch, a commit, or custom instructions. Uses the session settings and records source=mcp. Returns after the review turn starts; use agent_history to inspect progress.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        target: reviewTargetSchema,
      }),
      outputSchema: turn,
      annotations: openWorldMutation,
      action: "review",
    },
    ({ sessionId, target }) => agents.startReview(sessionId, target, "mcp"),
  );

  mcp.registerTool(
    "agent_history",
    {
      title: "Read Agent history",
      description:
        "Read one Agent conversation including human/MCP source, tool activity, file changes, artifacts, reasoning summaries, plans, and pending interactions with their offered approvalOptions. Returns the newest `limit` turns (default 20). Page backward with beforeTurnId set to the first returned turn id while hasEarlierTurns is true; fetch only newer turns with afterTurnId set to the last turn you have read.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(20)
          .describe("Maximum number of turns to return."),
        beforeTurnId: z
          .string()
          .min(1)
          .optional()
          .describe("Return turns before this turn id (older page)."),
        afterTurnId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Return turns after this turn id (newer turns since a previous read).",
          ),
      }),
      outputSchema: z.object({
        session,
        turns: z.array(
          z.object({
            turn,
            items: z.array(item),
          }),
        ),
        totalTurns: z.number().int().nonnegative(),
        hasEarlierTurns: z.boolean(),
        hasLaterTurns: z.boolean(),
      }),
      annotations: closedRead,
      action: "history",
      // The conversation itself is stored in the Agent tables; repeating it in
      // the operation log on every read only bloats the database.
      audit: {
        output: (value) => {
          const history = value as AgentHistoryPage;
          return {
            sessionId: history.session.id,
            provider: history.session.provider,
            status: history.session.status,
            turns: history.turns.map(({ turn }) => turn.id),
            totalTurns: history.totalTurns,
            items: history.turns.reduce(
              (count, entry) => count + entry.items.length,
              0,
            ),
          };
        },
      },
    },
    ({ sessionId, limit, beforeTurnId, afterTurnId }) => {
      if (beforeTurnId && afterTurnId)
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Use either beforeTurnId or afterTurnId, not both",
        );
      return agents.historyPage(sessionId, {
        limit,
        beforeTurnId: beforeTurnId ?? null,
        afterTurnId: afterTurnId ?? null,
      });
    },
  );

  mcp.registerTool(
    "agent_configure",
    {
      title: "Configure Agent session",
      description:
        "Atomically update model settings and provider-native permission settings for subsequent turns. Codex uses approvalPolicy, approvalsReviewer and permissionMode (sandbox); Claude Code uses permissionMode only. Omitted fields retain current values; null resets a field to its provider default. Read agent_providers for the exact native options.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        ...settingsPatchShape,
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "configure",
    },
    ({ sessionId, ...patch }) =>
      agents.configureSession(sessionId, configurationPatch(patch)),
  );

  mcp.registerTool(
    "agent_respond",
    {
      title: "Respond to Agent interaction",
      description:
        "Answer a pending Agent approval or structured input request. For approval, read interaction.approvalOptions in agent_history and submit one offered option’s id as the decision string.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        itemId: z.string().min(1),
        response: interactionResponse,
      }),
      outputSchema: item,
      annotations: openWorldMutation,
      action: "respond",
    },
    ({ sessionId, itemId, response }) =>
      agents.respondInteraction(sessionId, itemId, response),
  );

  mcp.registerTool(
    "agent_interrupt",
    {
      title: "Interrupt Agent",
      description: "Interrupt the active turn of an Agent session.",
      inputSchema: z.object({ sessionId: z.string().min(1) }),
      outputSchema: z.object({ ok: z.literal(true) }),
      annotations: destructiveLocalMutation,
      action: "interrupt",
    },
    async ({ sessionId }) => {
      await agents.interrupt(sessionId);
      return { ok: true as const };
    },
  );

  mcp.registerTool(
    "agent_switch_provider",
    {
      title: "Switch Agent provider",
      description:
        "Switch the active provider for the same Agent conversation, preserving visible history and synchronizing cross-provider context. Configure model settings from agent_models and provider-native permission settings from agent_providers. Omitted settings restore the target provider’s saved settings, or use defaults on its first activation; null resets a setting to its provider default. Returns the active target provider’s settings.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        provider,
        ...settingsPatchShape,
      }),
      outputSchema: session,
      annotations: destructiveLocalMutation,
      action: "switch_provider",
    },
    ({ sessionId, provider, ...patch }) =>
      agents.switchProvider(sessionId, provider, configurationPatch(patch)),
  );
}
