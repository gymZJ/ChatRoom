import { Router } from "express";
import { z } from "zod";
import type { ComputerService } from "#plugins/computer/computer-service";
import type { OperationLog } from "#operations/operation-log";
import type { IngressPolicy } from "#auth/ingress-policy";
import { asyncRoute, requireString } from "#presentation/http/http-utils";
import { ChatRoomError } from "#core/errors/chatroom-error";

const settingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    remoteAccess: z.boolean().optional(),
  })
  .strict();

export function createComputerApiRouter(
  computer: ComputerService,
  operations: OperationLog,
  ingress: IngressPolicy,
): Router {
  const router = Router();
  router.get(
    "/computer/status",
    asyncRoute(async (_req, res) => res.json(await computer.status())),
  );
  router.post(
    "/computer/permissions/accessibility/request",
    asyncRoute(async (req, res) => {
      assertLocalPermissionRequest(req);
      res.json(await computer.requestPermission("accessibility"));
    }),
  );
  router.post(
    "/computer/permissions/screen-recording/request",
    asyncRoute(async (req, res) => {
      assertLocalPermissionRequest(req);
      res.json(await computer.requestPermission("screenRecording"));
    }),
  );

  function assertLocalPermissionRequest(
    req: Parameters<IngressPolicy["isRemoteWeb"]>[0],
  ) {
    if (ingress.isRemoteWeb(req))
      throw new ChatRoomError(
        "FORBIDDEN",
        "Computer permissions can be requested only from the local Web UI",
      );
  }
  router.patch(
    "/computer/settings",
    asyncRoute(async (req, res) => {
      const parsed = settingsPatchSchema.parse(req.body);
      const patch = {
        ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
        ...(parsed.remoteAccess === undefined
          ? {}
          : { remoteAccess: parsed.remoteAccess }),
      };
      res.json(
        await operations.run(
          {
            pluginId: "computer",
            source: "gui",
            action: "settings.set",
            input: patch,
          },
          async () => computer.setSettings(patch),
        ),
      );
    }),
  );
  router.get("/computer/preview", (req, res) => {
    const scope = ingress.isRemoteWeb(req) ? "remote" : "local";
    res.json(
      presentPreview(
        computer.latestSnapshot(scope),
        computer.latestSnapshotTimestamp(),
      ),
    );
  });
  router.get("/computer/preview/image", (req, res) => {
    const scope = ingress.isRemoteWeb(req) ? "remote" : "local";
    const snapshotId = requireString(req.query.snapshotId, "snapshotId");
    const screenshot = computer.screenshot(scope, snapshotId);
    if (!screenshot)
      throw new ChatRoomError("NOT_FOUND", "Computer screenshot not found");
    const data = Buffer.from(screenshot.data, "base64");
    res.setHeader("Content-Type", screenshot.mimeType);
    res.setHeader("Content-Length", String(data.byteLength));
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(data);
  });
  router.post(
    "/computer/snapshot",
    asyncRoute(async (req, res) => {
      const scope = ingress.isRemoteWeb(req) ? "remote" : "local";
      const value = await computer.snapshot(scope, {
        includeScreenshot: true,
        includeElements: true,
      });
      res.json(presentPreview(value, computer.latestSnapshotTimestamp()));
    }),
  );
  return router;
}

function presentPreview(
  value: ReturnType<ComputerService["latestSnapshot"]>,
  capturedAt: string | null,
) {
  if (!value) return null;
  return {
    snapshotId: value.snapshotId,
    revision: value.revision,
    capturedAt,
    display: value.display,
    activeApp: value.activeApp,
    activeWindow: value.activeWindow,
    cursor: value.cursor,
    elementCount: value.elements.length,
    screenshot: value.screenshot
      ? { mimeType: value.screenshot.mimeType }
      : null,
  };
}
