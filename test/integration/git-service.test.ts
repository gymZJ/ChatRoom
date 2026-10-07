import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CommandRunner } from "../../src/core/runtime/command-runner.js";
import { GitService } from "../../src/plugins/git/git-service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

test("GitService projectFiles follows Git ignore rules and excludes ChatRoom internals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatroom-git-files-"));
  try {
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "chatroom@example.com");
    await git(dir, "config", "user.name", "ChatRoom Test");
    await mkdir(path.join(dir, ".chatroom"), { recursive: true });
    await mkdir(path.join(dir, "ignored"), { recursive: true });
    await mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(path.join(dir, "dist"), { recursive: true });
    await writeFile(path.join(dir, ".gitignore"), "ignored/\nnode_modules/\n");
    await writeFile(path.join(dir, "tracked.txt"), "tracked\n");
    await writeFile(path.join(dir, ".chatroom", "internal.txt"), "internal\n");
    await git(
      dir,
      "add",
      ".gitignore",
      "tracked.txt",
      ".chatroom/internal.txt",
    );
    await git(dir, "commit", "-m", "initial");

    await appendFile(path.join(dir, ".gitignore"), "tracked.txt\n");
    await writeFile(path.join(dir, "visible.txt"), "visible\n");
    await writeFile(path.join(dir, "ignored", "hidden.txt"), "hidden\n");
    await writeFile(
      path.join(dir, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
    );
    await writeFile(path.join(dir, "dist", "bundle.js"), "bundle\n");

    const service = new GitService(new CommandRunner());
    const files = await service.projectFiles(dir);
    assert.ok(files);
    assert.ok(files.includes(".gitignore"));
    assert.ok(files.includes("tracked.txt"), "tracked files remain visible");
    assert.ok(files.includes("visible.txt"));
    assert.ok(
      files.includes("dist/bundle.js"),
      "non-ignored generated-looking directories are not hard-coded away",
    );
    assert.ok(!files.includes(".chatroom/internal.txt"));
    assert.ok(!files.includes("ignored/hidden.txt"));
    assert.ok(!files.includes("node_modules/pkg/index.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
