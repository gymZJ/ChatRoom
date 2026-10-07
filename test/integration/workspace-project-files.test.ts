import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestRuntime } from "../helpers/runtime.js";

test("project files use only internal exclusions outside Git repositories", async () => {
  const runtime = await createTestRuntime();
  try {
    await mkdir(path.join(runtime.workspaceRoot, ".chatroom"), {
      recursive: true,
    });
    await mkdir(path.join(runtime.workspaceRoot, "node_modules", "pkg"), {
      recursive: true,
    });
    await mkdir(path.join(runtime.workspaceRoot, "dist"), { recursive: true });
    await mkdir(path.join(runtime.workspaceRoot, "src"), { recursive: true });
    await writeFile(
      path.join(runtime.workspaceRoot, ".chatroom", "internal.txt"),
      "internal\n",
    );
    await writeFile(
      path.join(runtime.workspaceRoot, "node_modules", "pkg", "index.js"),
      "module.exports = 1;\n",
    );
    await writeFile(
      path.join(runtime.workspaceRoot, "dist", "bundle.js"),
      "bundle\n",
    );
    await writeFile(
      path.join(runtime.workspaceRoot, "src", "main.ts"),
      "export {};\n",
    );

    await runtime.components.http.start();
    const address = runtime.components.http.address();
    assert.ok(address);
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/workspace/project-files?root=${encodeURIComponent(runtime.workspaceRoot)}`,
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      paths: string[];
      truncated: boolean;
    };
    assert.equal(result.truncated, false);
    assert.deepEqual(result.paths.sort(), [
      "dist/bundle.js",
      "node_modules/pkg/index.js",
      "src/main.ts",
    ]);
  } finally {
    await runtime.cleanup();
  }
});
