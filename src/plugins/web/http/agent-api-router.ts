import { Router } from "express";
import { z } from "zod";
import { ChatRoomError } from "#core/errors/chatroom-error";
import type { AgentRuntime } from "#plugins/agent/runtime";
import {
  attachmentSchema,
  configurationPatch,
  interactionResponseSchema,
  providerIdSchema,
  reviewTargetSchema,
  settingsPatchShape,
} from "#plugins/agent/schemas";
import { asyncRoute, requireString } from "#presentation/http/http-utils";

const createSessionBody = z.object({
  workspaceId: z.string().min(1),
  provider: providerIdSchema,
  ...settingsPatchShape,
});
const settingsPatchBody = z.object(settingsPatchShape);
const switchProviderBody = z.object({
  provider: providerIdSchema,
  ...settingsPatchShape,
});
const turnBody = z.object({
  text: z.string().default(""),
  attachments: z.array(attachmentSchema).default([]),
  outputSchema: z.unknown().optional(),
});
const steerBody = z.strictObject({
  text: z.string().default(""),
  attachments: z.array(attachmentSchema).default([]),
});
const reviewBody = z.strictObject({ target: reviewTargetSchema });
const bulkDeleteBody = z.object({
  sessionIds: z.array(z.string().min(1)).min(1).max(100),
});

export function createAgentApiRouter(agents: AgentRuntime): Router {
  const router = Router();

  router.get(
    "/agents/providers",
    asyncRoute(async (_req, res) => {
      res.json(await agents.providerStatuses());
    }),
  );

  router.get(
    "/agents/providers/:provider/models",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.models(providerIdSchema.parse(req.params.provider)),
      );
    }),
  );

  router.get(
    "/agents/providers/:provider/details",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.providerDetails(
          providerIdSchema.parse(req.params.provider),
        ),
      );
    }),
  );

  router.get("/agents/sessions", (_req, res) => {
    res.json(agents.listSessions());
  });

  router.post(
    "/agents/sessions",
    asyncRoute(async (req, res) => {
      const { workspaceId, provider, ...settings } = createSessionBody.parse(
        req.body,
      );
      res.json(
        await agents.createSession({
          workspaceId,
          provider,
          model: null,
          reasoningEffort: null,
          reasoningSummary: null,
          serviceTier: null,
          approvalPolicy: null,
          approvalsReviewer: null,
          permissionMode: null,
          ...configurationPatch(settings),
        }),
      );
    }),
  );

  router.get("/agents/sessions/:sessionId/history", (req, res) => {
    res.json(agents.history(requireString(req.params.sessionId, "sessionId")));
  });

  router.get("/agents/sessions/:sessionId/update", (req, res) => {
    res.json(
      agents.historyUpdate(
        requireString(req.params.sessionId, "sessionId"),
        parseIdList(req.query.turnIds),
        parseIdList(req.query.itemIds),
      ),
    );
  });

  router.put(
    "/agents/sessions/:sessionId/config",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.configureSession(
          requireString(req.params.sessionId, "sessionId"),
          configurationPatch(settingsPatchBody.parse(req.body)),
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/turns",
    asyncRoute(async (req, res) => {
      const body = turnBody.parse(req.body);
      res.json(
        await agents.startTurn(
          requireString(req.params.sessionId, "sessionId"),
          {
            text: body.text,
            attachments: body.attachments,
            outputSchema: body.outputSchema ?? null,
          },
          "human",
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/steer",
    asyncRoute(async (req, res) => {
      await agents.steer(
        requireString(req.params.sessionId, "sessionId"),
        steerBody.parse(req.body),
        "human",
      );
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/review",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.startReview(
          requireString(req.params.sessionId, "sessionId"),
          reviewBody.parse(req.body).target,
          "human",
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/interrupt",
    asyncRoute(async (req, res) => {
      await agents.interrupt(requireString(req.params.sessionId, "sessionId"));
      res.status(204).end();
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/interactions/:itemId",
    asyncRoute(async (req, res) => {
      res.json(
        await agents.respondInteraction(
          requireString(req.params.sessionId, "sessionId"),
          requireString(req.params.itemId, "itemId"),
          interactionResponseSchema.parse(req.body),
        ),
      );
    }),
  );

  router.post(
    "/agents/sessions/:sessionId/provider",
    asyncRoute(async (req, res) => {
      const { provider, ...settings } = switchProviderBody.parse(req.body);
      res.json(
        await agents.switchProvider(
          requireString(req.params.sessionId, "sessionId"),
          provider,
          configurationPatch(settings),
        ),
      );
    }),
  );

  const bulkDeleteSessions = asyncRoute(async (req, res) => {
    await agents.deleteSessions(bulkDeleteBody.parse(req.body).sessionIds);
    res.status(204).end();
  });
  // POST is the primary batch action for maximum compatibility with clients
  // and intermediaries that mishandle bodies on DELETE requests.
  router.post("/agents/sessions/bulk-delete", bulkDeleteSessions);
  router.delete("/agents/sessions", bulkDeleteSessions);

  router.delete(
    "/agents/sessions/:sessionId",
    asyncRoute(async (req, res) => {
      await agents.deleteSession(
        requireString(req.params.sessionId, "sessionId"),
      );
      res.status(204).end();
    }),
  );

  return router;
}

function parseIdList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const output = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") continue;
    for (const id of entry.split(",")) {
      if (!id) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new ChatRoomError("INVALID_INPUT", "Invalid Agent update id");
      output.add(id);
      if (output.size > 256)
        throw new ChatRoomError("INVALID_INPUT", "Too many Agent update ids");
    }
  }
  return [...output];
}
