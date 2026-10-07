import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatRoomError } from "#core/errors/chatroom-error";

export class WorkspaceRootPolicy {
  private constructor(private readonly allowedRoots: string[]) {}

  static async create(allowedRoots: string[]): Promise<WorkspaceRootPolicy> {
    const canonicalRoots = await Promise.all(
      allowedRoots.map(async (root) => {
        const canonical = await realpath(expandHome(root)).catch(() => {
          throw new ChatRoomError(
            "NOT_FOUND",
            `Allowed root does not exist: ${root}`,
          );
        });
        if (!(await stat(canonical)).isDirectory())
          throw new ChatRoomError(
            "INVALID_INPUT",
            `Allowed root is not a directory: ${root}`,
          );
        return canonical;
      }),
    );
    return new WorkspaceRootPolicy([...new Set(canonicalRoots)]);
  }

  roots(): string[] {
    return [...this.allowedRoots];
  }

  isWorkspaceRoot(candidate: string): boolean {
    return this.allowedRoots.some((root) => path.dirname(candidate) === root);
  }

  async resolveWorkspace(input: string): Promise<string> {
    if (typeof input !== "string" || !input.trim())
      throw new ChatRoomError("INVALID_INPUT", "Workspace root is required");
    const canonical = await realpath(expandHome(input)).catch(() => {
      throw new ChatRoomError(
        "NOT_FOUND",
        `Workspace root does not exist: ${input}`,
      );
    });
    if (!(await stat(canonical)).isDirectory())
      throw new ChatRoomError(
        "INVALID_INPUT",
        `Workspace root is not a directory: ${input}`,
      );
    if (!this.isWorkspaceRoot(canonical))
      throw new ChatRoomError(
        "FORBIDDEN",
        "Workspace must be a direct child of a configured allowed root",
        { root: canonical },
      );
    return canonical;
  }

  async resolveAllowedRoot(input: string): Promise<string> {
    if (typeof input !== "string" || !input.trim())
      throw new ChatRoomError("INVALID_INPUT", "Allowed root is required");
    const canonical = await realpath(expandHome(input)).catch(() => {
      throw new ChatRoomError(
        "NOT_FOUND",
        `Allowed root does not exist: ${input}`,
      );
    });
    if (!this.allowedRoots.includes(canonical))
      throw new ChatRoomError(
        "FORBIDDEN",
        "Project can only be created directly under a configured allowed root",
      );
    return canonical;
  }
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\"))
    return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}
