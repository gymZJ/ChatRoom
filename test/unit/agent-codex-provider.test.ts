import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { LogWriter } from "../../src/core/logging/types.js";
import type {
  AgentProviderContext,
  ProviderEvent,
} from "../../src/plugins/agent/provider.js";
import { CodexProvider } from "../../src/plugins/agent/providers/codex/provider.js";
import {
  CodexRpcClient,
  type CodexNotification,
} from "../../src/plugins/agent/providers/codex/rpc.js";

const logs: LogWriter = { debug() {}, info() {}, warn() {}, error() {} };
const context: AgentProviderContext = {
  workspaceRoot: path.resolve("test-workspace"),
  workspacePrompt: null,
  model: null,
  reasoningEffort: "high",
  reasoningSummary: "detailed",
  serviceTier: "default",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  permissionMode: null,
  continuityContext: null,
  continuityDelta: null,
};

function mockRpc(t: TestContext) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const notifications = new Set<(notification: CodexNotification) => void>();
  const results = new Map<string, unknown>([
    ["thread/start", { thread: { id: "thread-1" } }],
    ["thread/inject_items", {}],
    ["turn/start", { turn: { id: "turn-1" } }],
    ["turn/steer", { turnId: "turn-1" }],
    ["review/start", { turn: { id: "review-1" } }],
    [
      "configRequirements/read",
      { requirements: { allowedApprovalPolicies: ["on-request"] } },
    ],
    [
      "account/rateLimits/read",
      { rateLimits: { primary: { usedPercent: 10 } } },
    ],
  ]);
  t.mock.method(CodexRpcClient.prototype, "ensureStarted", async () => {
    throw new Error("Tests must never launch Codex");
  });
  t.mock.method(
    CodexRpcClient.prototype,
    "request",
    async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (!results.has(method))
        throw new Error(`Unexpected RPC request: ${method}`);
      const result = results.get(method);
      if (result instanceof Error) throw result;
      return result as T;
    },
  );
  t.mock.method(
    CodexRpcClient.prototype,
    "onNotification",
    (listener: (notification: CodexNotification) => void) => {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
  );
  t.mock.method(CodexRpcClient.prototype, "onServerRequest", () => () => {});
  t.mock.method(CodexRpcClient.prototype, "onTransportClose", () => () => {});
  t.mock.method(CodexRpcClient.prototype, "close", async () => {});
  return {
    calls,
    results,
    emit(method: string, params: Record<string, unknown>) {
      for (const listener of notifications)
        listener({ method, params: { threadId: "thread-1", ...params } });
    },
  };
}

async function nextEvent(
  iterator: AsyncIterator<ProviderEvent>,
): Promise<ProviderEvent> {
  const result = await iterator.next();
  assert.equal(result.done, false);
  assert.ok(result.value);
  return result.value;
}

test("Codex adapter injects the Workspace preset prompt when creating a thread", async (t) => {
  const rpc = mockRpc(t);
  const provider = new CodexProvider(logs);
  const session = await provider.createSession({
    ...context,
    workspacePrompt: "Always run the smallest relevant test before finishing.",
  });
  try {
    const injection = rpc.calls.find(
      ({ method }) => method === "thread/inject_items",
    );
    assert.ok(injection);
    assert.match(
      JSON.stringify(injection.params),
      /Always run the smallest relevant test before finishing\./,
    );
  } finally {
    await session.close();
    await provider.close();
  }
});

test("Codex adapter resolves catalog model id to the official execution model", async (t) => {
  const rpc = mockRpc(t);
  rpc.results.set("model/list", {
    data: [
      {
        id: "catalog-id",
        model: "wire-model-slug",
        displayName: "Catalog Model",
        description: "test",
        modelSpecialty: null,
        hidden: false,
        isDefault: false,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        supportedReasoningEfforts: [
          { reasoningEffort: "high", description: "High" },
        ],
        defaultReasoningEffort: "high",
        inputModalities: ["text"],
        multiAgentVersion: null,
        serviceTiers: [],
        defaultServiceTier: null,
        availableAccessPrograms: null,
      },
    ],
    nextCursor: null,
  });
  const provider = new CodexProvider(logs);
  const session = await provider.createSession({
    ...context,
    model: "catalog-id",
    serviceTier: null,
  });
  try {
    assert.equal(
      (
        rpc.calls.find(({ method }) => method === "thread/start")?.params as {
          model?: unknown;
        }
      ).model,
      "wire-model-slug",
    );
    const iterator = session
      .runTurn({
        text: "use selected model",
        attachments: [],
        outputSchema: null,
      })
      [Symbol.asyncIterator]();
    await nextEvent(iterator);
    assert.equal(
      (
        rpc.calls.find(({ method }) => method === "turn/start")?.params as {
          model?: unknown;
        }
      ).model,
      "wire-model-slug",
    );
    rpc.emit("turn/completed", {
      turn: { id: "turn-1", status: "completed", error: null },
    });
    await nextEvent(iterator);
  } finally {
    await session.close();
    await provider.close();
  }
});

test("Codex adapter applies updated settings on the next turn without experimental thread settings", async (t) => {
  const rpc = mockRpc(t);
  const provider = new CodexProvider(logs);
  const session = await provider.createSession(context);
  try {
    await session.configure({
      model: null,
      reasoningEffort: "medium",
      reasoningSummary: "concise",
      serviceTier: null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissionMode: null,
    });
    assert.equal(
      rpc.calls.some(({ method }) => method === "thread/settings/update"),
      false,
    );

    const iterator = session
      .runTurn({
        text: "use updated settings",
        attachments: [],
        outputSchema: null,
      })
      [Symbol.asyncIterator]();
    await nextEvent(iterator);
    assert.deepEqual(
      rpc.calls.find(({ method }) => method === "turn/start")?.params,
      {
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "use updated settings",
            text_elements: [],
          },
        ],
        outputSchema: null,
        cwd: context.workspaceRoot,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        model: null,
        serviceTier: null,
        effort: "medium",
        summary: "concise",
      },
    );
    rpc.emit("turn/completed", {
      turn: { id: "turn-1", status: "completed", error: null },
    });
    await nextEvent(iterator);
  } finally {
    await session.close();
    await provider.close();
  }
});

test("Codex forwards native sandbox permissions on creation, resume, and next-turn configuration", async (t) => {
  const rpc = mockRpc(t);
  rpc.results.set("thread/resume", { thread: { id: "thread-1" } });
  const provider = new CodexProvider(logs);
  const config = {
    ...context,
    permissionMode: "danger-full-access",
    approvalPolicy: "never",
  } as const;
  const session = await provider.createSession(config);
  const resumed = await provider.resumeSession(
    { ...context, permissionMode: "read-only" },
    "thread-1",
  );
  try {
    assert.equal(
      (
        rpc.calls.find(({ method }) => method === "thread/start")!.params as {
          sandbox: string;
        }
      ).sandbox,
      "danger-full-access",
    );
    assert.equal(
      (
        rpc.calls.find(({ method }) => method === "thread/resume")!.params as {
          sandbox: string;
        }
      ).sandbox,
      "read-only",
    );
    await session.configure({ ...config, permissionMode: "workspace-write" });
    const iterator = session
      .runTurn({ text: "test", attachments: [], outputSchema: null })
      [Symbol.asyncIterator]();
    await nextEvent(iterator);
    const updates = rpc.calls.filter(
      ({ method }) => method === "thread/resume",
    );
    assert.equal(updates.length, 2);
    assert.equal(
      (updates[1]!.params as { sandbox: string }).sandbox,
      "workspace-write",
    );
    rpc.emit("turn/completed", {
      turn: { id: "turn-1", status: "completed", error: null },
    });
    await nextEvent(iterator);
  } finally {
    await session.close();
    await resumed.close();
    await provider.close();
  }
});

test(
  "Codex adapter forwards output schema, steering input, and inline review targets through RPC",
  { timeout: 2000 },
  async (t) => {
    const rpc = mockRpc(t);
    const provider = new CodexProvider(logs);
    const session = await provider.createSession(context);
    try {
      const outputSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
      };
      const iterator = session
        .runTurn({
          text: "answer",
          attachments: [],
          outputSchema,
        })
        [Symbol.asyncIterator]();
      assert.deepEqual(await nextEvent(iterator), {
        type: "turn.started",
        providerTurnId: "turn-1",
      });
      assert.deepEqual(
        rpc.calls.find(({ method }) => method === "turn/start")?.params,
        {
          threadId: "thread-1",
          input: [{ type: "text", text: "answer", text_elements: [] }],
          outputSchema,
          cwd: context.workspaceRoot,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          model: null,
          serviceTier: "default",
          effort: "high",
          summary: "detailed",
        },
      );
      await session.steer!({
        text: "focus",
        attachments: [
          {
            kind: "audio",
            name: "clip.wav",
            path: "clip.wav",
            mimeType: "audio/wav",
          },
          {
            kind: "skill",
            name: "SKILL.md",
            path: "SKILL.md",
            mimeType: "text/markdown",
          },
        ],
      });
      assert.deepEqual(
        rpc.calls.find(({ method }) => method === "turn/steer")?.params,
        {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [
            { type: "text", text: "focus", text_elements: [] },
            {
              type: "localAudio",
              path: path.join(context.workspaceRoot, "clip.wav"),
            },
            {
              type: "skill",
              name: "SKILL.md",
              path: path.join(context.workspaceRoot, "SKILL.md"),
            },
          ],
        },
      );
      rpc.emit("turn/completed", {
        turn: { id: "turn-1", status: "completed", error: null },
      });
      assert.deepEqual(await nextEvent(iterator), {
        type: "turn.completed",
        status: "completed",
        error: null,
      });
      assert.equal((await iterator.next()).done, true);
      await assert.rejects(
        () => session.steer!({ text: "idle", attachments: [] }),
        /no active turn/,
      );
      const target = { type: "commit", sha: "abc123", title: null } as const;
      const review = session.runReview!(target)[Symbol.asyncIterator]();
      assert.deepEqual(await nextEvent(review), {
        type: "turn.started",
        providerTurnId: "review-1",
      });
      assert.deepEqual(
        rpc.calls.find(({ method }) => method === "review/start")?.params,
        { threadId: "thread-1", target, delivery: "inline" },
      );
      rpc.emit("turn/completed", {
        turn: { id: "review-1", status: "completed", error: null },
      });
      assert.deepEqual(await nextEvent(review), {
        type: "turn.completed",
        status: "completed",
        error: null,
      });
    } finally {
      await session.close();
      await provider.close();
    }
  },
);

test(
  "Codex adapter maps assistant phase, tool progress, turn diffs, and resolved request notifications",
  { timeout: 2000 },
  async (t) => {
    const rpc = mockRpc(t);
    const provider = new CodexProvider(logs);
    const session = await provider.createSession(context);
    try {
      const iterator = session
        .runTurn({
          text: "inspect",
          attachments: [],
          outputSchema: null,
        })
        [Symbol.asyncIterator]();
      await nextEvent(iterator);
      rpc.emit("item/started", {
        item: {
          type: "agentMessage",
          id: "answer",
          text: "Working",
          phase: "commentary",
        },
      });
      assert.deepEqual(await nextEvent(iterator), {
        type: "item.started",
        providerItemId: "answer",
        item: {
          type: "assistant_message",
          text: "Working",
          phase: "commentary",
        },
      });
      rpc.emit("item/started", {
        item: {
          type: "mcpToolCall",
          id: "tool",
          tool: "inspect",
          server: "workspace",
          arguments: { path: "file.ts" },
        },
      });
      const tool = await nextEvent(iterator);
      assert.equal(tool.type, "item.started");
      rpc.emit("item/mcpToolCall/progress", {
        itemId: "tool",
        message: "Read 2 files",
      });
      assert.deepEqual(await nextEvent(iterator), {
        type: "item.updated",
        providerItemId: "tool",
        item: {
          type: "tool",
          name: "inspect",
          server: "workspace",
          input: { path: "file.ts" },
          output: null,
          error: null,
          progress: "Read 2 files",
        },
      });
      for (const [index, diff] of ["first diff", "updated diff"].entries()) {
        rpc.emit("turn/diff/updated", { turnId: "turn-1", diff });
        assert.deepEqual(await nextEvent(iterator), {
          type: index === 0 ? "item.started" : "item.updated",
          providerItemId: "turn-diff:turn-1",
          item: { type: "turn_diff", diff },
        });
      }
      for (const phase of ["started", "completed"] as const) {
        rpc.emit("item/" + phase, {
          item: { id: "compact-1", type: "contextCompaction" },
        });
        const event = await nextEvent(iterator);
        assert.equal(event.type, "item." + phase);
        assert.ok("item" in event);
        assert.deepEqual(event.item, {
          type: "context_compaction",
          trigger: null,
          error: null,
        });
      }
      rpc.emit("serverRequest/resolved", { requestId: 42 });
      assert.deepEqual(await nextEvent(iterator), {
        type: "interaction.resolved",
        providerRequestId: "42",
      });
      rpc.emit("item/completed", {
        item: {
          type: "agentMessage",
          id: "answer",
          text: "Done",
          phase: "final_answer",
        },
      });
      assert.deepEqual(await nextEvent(iterator), {
        type: "item.completed",
        failed: false,
        providerItemId: "answer",
        item: {
          type: "assistant_message",
          text: "Done",
          phase: "final_answer",
        },
      });
      rpc.emit("turn/completed", {
        turn: { id: "turn-1", status: "completed", error: null },
      });
      const remaining: ProviderEvent[] = [];
      for (;;) {
        const event = await iterator.next();
        if (event.done) break;
        remaining.push(event.value);
      }
      assert.ok(
        remaining.some(
          (event) =>
            event.type === "item.completed" &&
            event.item.type === "turn_diff" &&
            event.item.diff === "updated diff",
        ),
      );
      assert.deepEqual(remaining.at(-1), {
        type: "turn.completed",
        status: "completed",
        error: null,
      });
    } finally {
      await session.close();
      await provider.close();
    }
  },
);
