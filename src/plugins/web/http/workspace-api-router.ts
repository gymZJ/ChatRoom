import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import { ChatRoomError } from "#core/errors/chatroom-error";
import {
  asyncRoute,
  bodyRecord,
  boundedIntegerQuery,
  requireString,
} from "#presentation/http/http-utils";
import type { WebRuntime } from "#plugins/web/runtime";

const MAX_WRITE_BYTES = 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PREVIEW_BYTES = 32 * 1024 * 1024;

export function createWorkspaceApiRouter(application: WebRuntime): Router {
  const router = Router();

  router.get(
    "/workspaces",
    asyncRoute(async (_req, res) => {
      res.json(await application.workspaces.list());
    }),
  );

  router.post(
    "/workspaces",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      const parent = requireString(body.parent, "parent");
      const name = requireString(body.name, "name");
      res.json(
        await application.operations.run(
          {
            pluginId: "workspace",
            source: "gui",
            action: "create",
            input: { parent, name },
          },
          () => application.workspaces.createProject(parent, name),
        ),
      );
    }),
  );

  router.get("/workspace/roots", (_req, res) => {
    res.json(application.workspaces.roots());
  });

  router.get(
    "/workspace",
    asyncRoute(async (req, res) => {
      res.json(
        await application.workspaces.info(
          requireString(req.query.root, "root"),
        ),
      );
    }),
  );

  router.get(
    "/workspace/files",
    asyncRoute(async (req, res) => {
      const fs = await application.workspaces.fs(
        requireString(req.query.root, "root"),
      );
      const filePath =
        typeof req.query.path === "string" ? req.query.path : ".";
      const limit = boundedIntegerQuery(req.query.limit, 300, 1, 500);
      const offset = boundedIntegerQuery(req.query.offset, 0, 0, 100000);
      const page = await fs.list(filePath, {
        recursive: req.query.recursive === "1",
        offset,
        maxEntries: limit + 1,
      });
      const hasMore = page.length > limit;
      res.json({
        items: page.slice(0, limit),
        nextOffset: hasMore ? offset + limit : null,
      });
    }),
  );

  router.get(
    "/workspace/project-files",
    asyncRoute(async (req, res) => {
      res.json(
        await application.workspaces.projectFilesResult(
          requireString(req.query.root, "root"),
        ),
      );
    }),
  );

  router.get(
    "/workspace/file",
    asyncRoute(async (req, res) => {
      const fs = await application.workspaces.fs(
        requireString(req.query.root, "root"),
      );
      res.json(
        await fs.read(requireString(req.query.path, "path"), {
          maxBytes: 2 * 1024 * 1024,
        }),
      );
    }),
  );

  router.put(
    "/workspace/file",
    asyncRoute(async (req, res) => {
      const body = bodyRecord(req.body);
      const fs = await application.workspaces.fs(
        requireString(body.root, "root"),
      );
      const filePath = requireString(body.path, "path");
      if (typeof body.content !== "string")
        throw new ChatRoomError("INVALID_INPUT", "content must be a string");
      const bytes = Buffer.byteLength(body.content, "utf8");
      if (bytes > MAX_WRITE_BYTES)
        throw new ChatRoomError(
          "INVALID_INPUT",
          `File content exceeds ${MAX_WRITE_BYTES} bytes`,
        );
      res.json(
        await application.operations.run(
          {
            pluginId: "workspace",
            source: "gui",
            action: "file.write",
            input: { root: fs.root, path: filePath, bytes },
          },
          () => fs.write(filePath, body.content as string),
        ),
      );
    }),
  );

  router.post(
    "/workspace/attachment",
    express.raw({
      type: "application/octet-stream",
      limit: MAX_ATTACHMENT_BYTES,
    }),
    asyncRoute(async (req, res) => {
      const root = requireString(req.query.root, "root");
      const sessionId = requireString(req.query.sessionId, "sessionId");
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId))
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Invalid attachment session id",
        );
      const originalName = requireString(req.query.name, "name");
      if (!Buffer.isBuffer(req.body))
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Attachment body must be binary",
        );
      const fs = await application.workspaces.fs(root);
      const session = application.agents.getSession(sessionId);
      if (session.workspaceRoot !== fs.root)
        throw new ChatRoomError(
          "FORBIDDEN",
          "Agent session belongs to another workspace",
        );
      const filePath =
        ".chatroom/agent-attachments/" +
        sessionId +
        "/" +
        randomUUID() +
        "-" +
        attachmentFileName(originalName);
      const file = await application.operations.run(
        {
          pluginId: "workspace",
          source: "gui",
          action: "attachment.upload",
          input: { root: fs.root, path: filePath, bytes: req.body.byteLength },
        },
        () => fs.writeBytes(filePath, req.body),
      );
      res.json({
        ...file,
        name: originalName,
        mimeType:
          typeof req.headers["x-chatroom-mime-type"] === "string"
            ? req.headers["x-chatroom-mime-type"]
            : null,
      });
    }),
  );

  router.get(
    "/workspace/file/image",
    asyncRoute(async (req, res) => {
      const filePath = requireString(req.query.path, "path");
      const mime = imageMime(filePath);
      if (!mime)
        throw new ChatRoomError(
          "INVALID_INPUT",
          "File type is not supported for image preview",
        );
      const fs = await application.workspaces.fs(
        requireString(req.query.root, "root"),
      );
      const file = await fs.readBytes(filePath, {
        maxBytes: MAX_IMAGE_PREVIEW_BYTES,
      });
      if (file.truncated)
        throw new ChatRoomError(
          "INVALID_INPUT",
          "Image is too large to preview",
        );

      const etag =
        'W/"' +
        file.bytes.toString(16) +
        "-" +
        Date.parse(file.modifiedAt).toString(16) +
        '"';
      const requestedVersion =
        typeof req.query.v === "string" ? req.query.v : null;

      res.setHeader("Content-Type", mime);
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", file.modifiedAt);
      res.setHeader(
        "Cache-Control",
        requestedVersion === file.modifiedAt
          ? "private, max-age=31536000, immutable"
          : "private, no-cache",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("Content-Length", String(file.data.byteLength));
      res.send(file.data);
    }),
  );

  return router;
}

function imageMime(filePath: string): string | null {
  switch (filePath.split(".").pop()?.toLowerCase()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    default:
      return null;
  }
}

function attachmentFileName(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() ?? "";
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (safe || "attachment").slice(0, 160);
}
