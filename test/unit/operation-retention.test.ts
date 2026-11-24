import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeEventBus } from "../../src/app/event-bus.js";
import { AppDatabase } from "../../src/infrastructure/database/app-database.js";
import { OperationRepository } from "../../src/infrastructure/database/operation-repository.js";
import { OperationLog } from "../../src/operations/operation-log.js";
import { auditProcessSnapshot } from "../../src/plugins/process/mcp.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-operations-"));
  const database = new AppDatabase(path.join(root, "app.sqlite"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const repository = new OperationRepository(database);
  const events = new RuntimeEventBus();
  const emitted: string[] = [];
  events.subscribe((event) => emitted.push(event.type));
  return { database, repository, events, emitted };
}

function record(
  log: OperationLog,
  action: string,
  startedAt: string,
  status: "success" | "running" = "success",
) {
  const operation = log.start({
    pluginId: "process",
    source: "mcp",
    action,
    input: { action },
  });
  if (status === "success")
    log.finish(operation.operationId, "success", { output: "x".repeat(64) });
  const stored = log.get(operation.operationId)!;
  // Backdate deterministically for retention.
  return { ...stored, startedAt };
}

test("operation retention prunes by age and count but keeps running operations", async (t) => {
  const { repository, events, emitted } = await fixture(t);
  const log = new OperationLog(repository, events, 4096, {
    maxAgeDays: 30,
    maxEntries: 2,
  });
  const now = new Date("2026-06-01T00:00:00.000Z");
  const day = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * day).toISOString();
  for (const [action, daysAgo, status] of [
    ["ancient", 45, "success"],
    ["old-running", 45, "running"],
    ["a", 3, "success"],
    ["b", 2, "success"],
    ["c", 1, "success"],
  ] as const) {
    repository.update(record(log, action, at(daysAgo), status));
  }

  assert.equal(log.prune(now), 2);
  assert.deepEqual(
    log
      .listSummaries({ limit: 10 })
      .map((operation) => operation.action)
      .sort(),
    ["b", "c", "old-running"],
  );
  assert.equal(emitted.includes("operations-cleared"), false);
  assert.equal(log.prune(now), 0);

  const withoutPolicy = new OperationLog(repository, events, 4096);
  assert.equal(withoutPolicy.prune(new Date("2030-01-01T00:00:00Z")), 0);
});

test("operation summaries omit recorded payloads", async (t) => {
  const { repository, events } = await fixture(t);
  const log = new OperationLog(repository, events, 4096);
  record(log, "read", new Date().toISOString());
  const [summary] = log.listSummaries();
  assert.ok(summary);
  assert.equal(summary.action, "read");
  assert.equal("input" in summary, false);
  assert.equal("output" in summary, false);
  assert.equal("error" in summary, false);
  const [full] = log.list();
  assert.deepEqual(full?.input, { action: "read" });
});

test("database compaction only runs when most of a large file is free", async (t) => {
  const { database, repository, events } = await fixture(t);
  const log = new OperationLog(repository, events, 512 * 1024, {
    maxAgeDays: 1,
    maxEntries: 100,
  });
  assert.equal(database.compactIfSparse(), false);
  for (let index = 0; index < 40; index += 1) {
    const operation = log.start({
      pluginId: "process",
      source: "mcp",
      action: "read",
    });
    log.finish(operation.operationId, "success", "y".repeat(100_000));
  }
  log.clearHistory();
  assert.equal(database.compactIfSparse(1024 * 1024), true);
  assert.equal(database.compactIfSparse(1024 * 1024), false);
});

test("process polling audit keeps state and the output tail only", () => {
  const audited = auditProcessSnapshot({
    processId: "p1",
    state: "running",
    stdout: "a".repeat(10_000) + "END",
    stderr: "",
  }) as Record<string, unknown>;
  assert.equal(audited.processId, "p1");
  assert.equal(audited.state, "running");
  assert.equal(audited.stdoutChars, 10_003);
  assert.equal(audited.stderrChars, 0);
  assert.equal((audited.stdout as string).length, 4097);
  assert.match(audited.stdout as string, /END$/);
  assert.equal(audited.stderr, "");
});
