import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ClaudeLaunch {
  command: string;
  args: string[];
}

interface ClaudeLaunchOptions {
  platform?: NodeJS.Platform;
  path?: string;
  nodeExecutable?: string;
  exists?: (path: string) => boolean;
  home?: string;
}

/**
 * The native installer exposes claude.exe on Windows, while npm installs a
 * claude.cmd shim that child_process.spawn cannot execute without a shell.
 * Prefer the native executable and launch the npm JS entry point with Node.
 *
 * The native installer puts claude in ~/.local/bin, which is often missing
 * from the PATH of services (systemd, launchd), so fall back to it.
 */
export function resolveClaudeLaunch({
  platform = process.platform,
  path = process.env.PATH ?? "",
  nodeExecutable = process.execPath,
  exists = existsSync,
  home = homedir(),
}: ClaudeLaunchOptions = {}): ClaudeLaunch {
  if (platform !== "win32") {
    for (const directory of path.split(":"))
      if (directory && exists(posix.join(directory, "claude")))
        return { command: "claude", args: [] };
    for (const candidate of [
      posix.join(home, ".local", "bin", "claude"),
      posix.join(home, ".claude", "local", "claude"),
    ])
      if (exists(candidate)) return { command: candidate, args: [] };
    return { command: "claude", args: [] };
  }

  for (const entry of path.split(";")) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (!directory) continue;

    const executable = win32.join(directory, "claude.exe");
    if (exists(executable)) return { command: executable, args: [] };

    const npmShim = win32.join(directory, "claude.cmd");
    const npmEntry = win32.join(
      directory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );
    if (exists(npmShim) && exists(npmEntry))
      return { command: nodeExecutable, args: [npmEntry] };
  }

  const installed = win32.join(home, ".local", "bin", "claude.exe");
  if (exists(installed)) return { command: installed, args: [] };
  return { command: "claude", args: [] };
}
