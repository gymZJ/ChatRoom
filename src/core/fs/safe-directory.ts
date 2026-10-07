import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ChatRoomError } from "#core/errors/chatroom-error";

export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.includes("\0"))
    throw new ChatRoomError("INVALID_INPUT", "Path must be a valid string");
  if (
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    /^\\\\/.test(input)
  )
    throw new ChatRoomError("FORBIDDEN", "Absolute paths are not allowed");
  const parts = input
    .split(/[\\/]+/)
    .filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".."))
    throw new ChatRoomError("FORBIDDEN", "Path traversal is not allowed");
  return parts.join("/") || ".";
}

export async function resolveReadableWithin(
  root: string,
  relativePath: string,
): Promise<string> {
  const lexical = lexicalWithin(root, relativePath);
  const canonical = await realpath(lexical).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ChatRoomError(
        "NOT_FOUND",
        `Path does not exist: ${relativePath}`,
      );
    throw error;
  });
  if (!inside(root, canonical))
    throw new ChatRoomError("FORBIDDEN", "Symlink escapes root directory");
  return canonical;
}

export async function resolveReadableFileWithin(
  root: string,
  relativePath: string,
): Promise<{ absolute: string; relative: string }> {
  const absolute = await resolveReadableWithin(root, relativePath);
  if (!(await stat(absolute)).isFile())
    throw new ChatRoomError("INVALID_INPUT", `Not a file: ${relativePath}`);
  return {
    absolute,
    relative: path.relative(root, absolute).split(path.sep).join("/"),
  };
}

export async function resolveWritableWithin(
  root: string,
  relativePath: string,
): Promise<string> {
  const target = lexicalWithin(root, relativePath);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < parts.length - 1; index++) {
    current = path.join(current, parts[index]!);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
      }
      info = await lstat(current);
    }

    if (info.isSymbolicLink())
      throw new ChatRoomError(
        "FORBIDDEN",
        `Writes through symlinked directories are not allowed: ${relativePath}`,
      );
    if (!info.isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        `Parent is not a directory: ${parts[index]}`,
      );
    const canonical = await realpath(current);
    if (!inside(root, canonical))
      throw new ChatRoomError("FORBIDDEN", "Write path escapes root directory");
  }

  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink())
      throw new ChatRoomError(
        "FORBIDDEN",
        `Writes through symlinks are not allowed: ${relativePath}`,
      );
    if (!targetInfo.isFile())
      throw new ChatRoomError("INVALID_INPUT", `Not a file: ${relativePath}`);
  } catch (error) {
    if (error instanceof ChatRoomError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return target;
}

export async function writeBytesAtomicWithin(
  root: string,
  relativePath: string,
  content: Uint8Array,
  mode = 0o600,
): Promise<void> {
  const target = await resolveWritableWithin(root, relativePath);
  const temporary = `${target}.chatroom-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function removeFileWithin(
  root: string,
  relativePath: string,
): Promise<void> {
  const target = lexicalWithin(root, relativePath);
  const relative = path.relative(root, target);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < parts.length - 1; index++) {
    current = path.join(current, parts[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new ChatRoomError(
        "FORBIDDEN",
        `Removal through symlinked directories is not allowed: ${relativePath}`,
      );
    if (!info.isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        `Parent is not a directory: ${parts[index]}`,
      );
    if (!inside(root, await realpath(current)))
      throw new ChatRoomError(
        "FORBIDDEN",
        "Removal path escapes root directory",
      );
  }

  const info = await lstat(target);
  if (!info.isFile() && !info.isSymbolicLink())
    throw new ChatRoomError("INVALID_INPUT", `Not a file: ${relativePath}`);
  await rm(target, { force: true });
}

function lexicalWithin(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(root, ...normalized.split("/"));
  if (!inside(root, absolute))
    throw new ChatRoomError("FORBIDDEN", "Path escapes root directory");
  return absolute;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}
