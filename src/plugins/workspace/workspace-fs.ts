import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ChatRoomError } from "#core/errors/chatroom-error";
import {
  normalizeRelativePath,
  resolveReadableWithin,
  resolveWritableWithin,
  writeBytesAtomicWithin,
} from "#core/fs/safe-directory";
import type { WorkspaceFile } from "./types.js";

export class WorkspaceFs {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<WorkspaceFs> {
    const canonical = await realpath(path.resolve(root)).catch(() => {
      throw new ChatRoomError(
        "NOT_FOUND",
        `Workspace root does not exist: ${root}`,
      );
    });
    const info = await stat(canonical);
    if (!info.isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        `Workspace root is not a directory: ${root}`,
      );
    return new WorkspaceFs(canonical);
  }

  async fileInfo(
    relativePath: string,
  ): Promise<{ bytes: number; modifiedAt: string }> {
    const target = await resolveReadableWithin(this.root, relativePath);
    const info = await stat(target);
    if (!info.isFile())
      throw new ChatRoomError("INVALID_INPUT", `Not a file: ${relativePath}`);
    return { bytes: info.size, modifiedAt: info.mtime.toISOString() };
  }

  async read(
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<{
    content: string;
    bytes: number;
    truncated: boolean;
    modifiedAt: string;
  }> {
    const result = await this.readBytes(relativePath, options);
    return {
      content: result.data.toString("utf8"),
      bytes: result.bytes,
      truncated: result.truncated,
      modifiedAt: result.modifiedAt,
    };
  }

  async readBytes(
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<{
    data: Buffer;
    bytes: number;
    truncated: boolean;
    modifiedAt: string;
  }> {
    const target = await resolveReadableWithin(this.root, relativePath);
    const maxBytes = options.maxBytes ?? 1024 * 1024;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const handle = await open(target, "r");
      try {
        const before = await handle.stat();
        if (!before.isFile())
          throw new ChatRoomError(
            "INVALID_INPUT",
            `Not a file: ${relativePath}`,
          );

        const readSize = Math.min(before.size, maxBytes);
        const buffer = Buffer.alloc(readSize);
        let bytesRead = 0;
        while (bytesRead < readSize) {
          const result = await handle.read(
            buffer,
            bytesRead,
            readSize - bytesRead,
            bytesRead,
          );
          if (result.bytesRead === 0) break;
          bytesRead += result.bytesRead;
        }

        const after = await handle.stat();
        const stable =
          before.size === after.size &&
          before.mtimeMs === after.mtimeMs &&
          before.ctimeMs === after.ctimeMs;
        if (stable)
          return {
            data: buffer.subarray(0, bytesRead),
            bytes: after.size,
            truncated: after.size > maxBytes,
            modifiedAt: after.mtime.toISOString(),
          };
      } finally {
        await handle.close();
      }
    }

    throw new ChatRoomError(
      "CONFLICT",
      `File changed while being read: ${relativePath}`,
    );
  }

  async write(relativePath: string, content: string): Promise<WorkspaceFile> {
    if (typeof content !== "string")
      throw new ChatRoomError("INVALID_INPUT", "File content must be a string");

    const normalized = normalizeRelativePath(relativePath);
    if (normalized === ".")
      throw new ChatRoomError("INVALID_INPUT", "File path is required");

    const target = await resolveWritableWithin(this.root, normalized);
    let mode = 0o644;
    try {
      const info = await lstat(target);
      if (!info.isFile())
        throw new ChatRoomError("INVALID_INPUT", `Not a file: ${relativePath}`);
      mode = info.mode & 0o777;
    } catch (error) {
      if (error instanceof ChatRoomError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await writeBytesAtomicWithin(
      this.root,
      normalized,
      Buffer.from(content, "utf8"),
      mode,
    );

    return {
      path: normalized,
      type: "file",
      size: Buffer.byteLength(content, "utf8"),
    };
  }

  async writeBytes(
    relativePath: string,
    content: Uint8Array,
  ): Promise<WorkspaceFile> {
    const normalized = normalizeRelativePath(relativePath);
    if (normalized === ".")
      throw new ChatRoomError("INVALID_INPUT", "File path is required");

    await writeBytesAtomicWithin(this.root, normalized, content);

    return {
      path: normalized,
      type: "file",
      size: content.byteLength,
    };
  }

  async list(
    relativePath = ".",
    options: {
      recursive?: boolean;
      maxEntries?: number;
      excludeDirectoryNames?: readonly string[];
      offset?: number;
    } = {},
  ): Promise<WorkspaceFile[]> {
    const start = await resolveReadableWithin(this.root, relativePath);
    if (!(await stat(start)).isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        `Not a directory: ${relativePath}`,
      );

    const maxEntries = Math.min(options.maxEntries ?? 1000, 10000);
    const offset = Math.max(0, options.offset ?? 0);
    const excluded = new Set(options.excludeDirectoryNames ?? []);
    const output: WorkspaceFile[] = [];
    let seen = 0;
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (output.length >= maxEntries) return;
        if (entry.isDirectory() && excluded.has(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const info = await lstat(absolute);
        const type: WorkspaceFile["type"] = info.isSymbolicLink()
          ? "symlink"
          : info.isDirectory()
            ? "directory"
            : "file";
        const relative = path
          .relative(this.root, absolute)
          .split(path.sep)
          .join("/");
        if (seen >= offset) {
          output.push({
            path: relative,
            type,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
        seen += 1;
        if (options.recursive && entry.isDirectory() && !entry.isSymbolicLink())
          await walk(absolute);
      }
    };
    await walk(start);
    return output;
  }
}
