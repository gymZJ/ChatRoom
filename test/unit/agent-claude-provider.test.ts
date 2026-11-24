import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { silentLogs as logs } from "../helpers/agent.js";
import type {
  AgentProviderContext,
  ProviderEvent,
} from "../../src/plugins/agent/provider.js";
import { resolveClaudeLaunch } from "../../src/plugins/agent/providers/claude/launch.js";
import {
  claudeAccountUsage,
  claudeModels,
  claudeSessionChoices,
  claudeUsage,
  structuredPatchDiff,
} from "../../src/plugins/agent/providers/claude/mapping.js";
import { ClaudeCodeProvider } from "../../src/plugins/agent/providers/claude/provider.js";

test("Claude Code model catalog hides the default alias and marks its target", () => {
  const models = claudeModels([
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      displayName: "Default (recommended)",
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "Opus",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high"],
      supportsAdaptiveThinking: true,
    },
    { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku" },
  ]);
  assert.deepEqual(
    models.map((model) => [model.id, model.isDefault]),
    [
      ["opus", true],
      ["haiku", false],
    ],
  );
  assert.deepEqual(
    models[0]!.reasoningEfforts.map((effort) => effort.id),
    ["low", "high"],
  );
  assert.deepEqual(models[0]!.reasoningSummaries, ["auto", "none"]);
  assert.deepEqual(models[1]!.reasoningEfforts, []);
  assert.deepEqual(models[1]!.reasoningSummaries, []);
});

test("Claude Code usage folds cache tokens into input like Codex", () => {
  assert.deepEqual(
    claudeUsage({
      input_tokens: 10,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
      output_tokens: 7,
      output_tokens_details: { thinking_tokens: 3 },
    }),
    {
      totalTokens: 137,
      inputTokens: 130,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
      outputTokens: 7,
      reasoningOutputTokens: 3,
    },
  );
});

test("Claude Code account usage maps plan windows and extra usage", () => {
  const usage = claudeAccountUsage({
    subscription_type: "max",
    rate_limits: {
      five_hour: { utilization: 12, resets_at: "2026-01-01T00:00:00Z" },
      seven_day_opus: { utilization: 40, resets_at: null },
      model_scoped: [
        { display_name: "Fable", utilization: 5, resets_at: null },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 25,
        utilization: 25,
        currency: "USD",
      },
    },
  });
  assert.equal(usage?.subscriptionType, "max");
  assert.deepEqual(
    usage?.windows.map((window) => [window.id, window.utilization]),
    [
      ["five_hour", 12],
      ["seven_day_opus", 40],
      ["model:Fable", 5],
    ],
  );
  assert.deepEqual(usage?.extraUsage, {
    enabled: true,
    monthlyLimit: 100,
    usedCredits: 25,
    utilization: 25,
    currency: "USD",
  });
  assert.equal(claudeAccountUsage({ subscription_type: null }), null);
});

test("Claude Code session approvals state their scope and offer a tool-wide allow", () => {
  const exact = claudeSessionChoices("Bash", [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "git --version" }],
      behavior: "allow",
      destination: "localSettings",
    },
  ]);
  assert.deepEqual(
    exact.map((choice) => [choice.id, choice.description]),
    [
      ["acceptCommandForSession", "Bash(git --version)"],
      ["acceptToolForSession", "Bash"],
    ],
  );
  assert.equal(exact[0]!.updatedPermissions[0]!.destination, "session");
  assert.deepEqual(exact[1]!.updatedPermissions, [
    {
      type: "addRules",
      rules: [{ toolName: "Bash" }],
      behavior: "allow",
      destination: "session",
    },
  ]);

  const mixed = claudeSessionChoices("Bash", [
    {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "touch a" }],
      behavior: "allow",
      destination: "localSettings",
    },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ]);
  assert.deepEqual(
    mixed.map((choice) => [choice.id, choice.description]),
    [
      ["acceptForSession", "Bash(touch a); mode: acceptEdits"],
      ["acceptToolForSession", "Bash"],
    ],
  );

  assert.deepEqual(
    claudeSessionChoices("Write", [
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]).map((choice) => choice.id),
    ["acceptEditsForSession"],
  );
  assert.deepEqual(
    claudeSessionChoices("Edit", []).map((choice) => choice.id),
    ["acceptEditsForSession"],
  );
  assert.deepEqual(
    claudeSessionChoices("mcp__chatroom_agent__workspace_list", []).map(
      (choice) => choice.updatedPermissions,
    ),
    [
      [
        {
          type: "addRules",
          rules: [{ toolName: "mcp__chatroom_agent__workspace_list" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    ],
  );
});

test("Claude Code structured patches render as unified hunks", () => {
  assert.equal(
    structuredPatchDiff([
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-a", "+b"],
      },
    ]),
    "@@ -1,1 +1,1 @@\n-a\n+b",
  );
});

test("Claude Code launches the npm Windows shim via its JS entry point", () => {
  const directory = "C:\\Users\\example\\AppData\\Roaming\\npm";
  const shim = directory + "\\claude.cmd";
  const entry =
    directory + "\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  assert.deepEqual(
    resolveClaudeLaunch({
      platform: "win32",
      path: "C:\\missing;" + directory,
      nodeExecutable: "C:\\node\\node.exe",
      exists: (candidate) => candidate === shim || candidate === entry,
    }),
    { command: "C:\\node\\node.exe", args: [entry] },
  );
  assert.deepEqual(
    resolveClaudeLaunch({
      platform: "win32",
      path: "C:\\tools",
      exists: (candidate) => candidate === "C:\\tools\\claude.exe",
    }),
    { command: "C:\\tools\\claude.exe", args: [] },
  );
  assert.deepEqual(
    resolveClaudeLaunch({
      platform: "linux",
      path: "/usr/bin",
      home: "/home/u",
      exists: (candidate) => candidate === "/usr/bin/claude",
    }),
    { command: "claude", args: [] },
  );
  assert.deepEqual(
    resolveClaudeLaunch({
      platform: "linux",
      path: "/usr/bin",
      home: "/home/u",
      exists: (candidate) => candidate === "/home/u/.local/bin/claude",
    }),
    { command: "/home/u/.local/bin/claude", args: [] },
  );
});

// A stand-in for the Claude Code CLI that speaks the stream-json control
// protocol and logs what ChatRoom sends into the workspace directory.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, apiProvider: "firstParty" })); process.exit(0); }
const session = args.includes("--session-id") || args.includes("--resume");
const log = (entry) => { if (session) fs.appendFileSync("claude-log.jsonl", JSON.stringify(entry) + "\n"); };
log({ args, token: process.env.CHATROOM_AGENT_MCP_TOKEN, ask: process.env.CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL });
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const waiting = new Map();
let pendingSteer = false;
const models = [
  { value: "default", resolvedModel: "claude-test", displayName: "Default" },
  { value: "test", resolvedModel: "claude-test", displayName: "Test", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
];
function result(extra = {}) {
  out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s",
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
    modelUsage: { "claude-test": { contextWindow: 200000 } }, queued_turn_count: 0, ...extra });
}
function ask(id, request) {
  out({ type: "control_request", request_id: id, request });
  return new Promise((resolve) => waiting.set(id, resolve));
}
async function onUser(message) {
  const text = message.message.content.map((block) => block.text || "").join("");
  log({ user: message });
  if (message.priority === "next") { pendingSteer = false; result(); return; }
  out({ type: "system", subtype: "init", session_id: "s" });
  if (text.includes("tools")) {
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "m1" } } });
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    out({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me" } } });
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "text", text: "Let me look." }], usage: { input_tokens: 4, cache_read_input_tokens: 50, output_tokens: 2 } } });
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    const decision = await ask("perm-1", { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "t1",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls" }], behavior: "allow", destination: "localSettings" }] });
    log({ decision });
    out({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt", is_error: false }] }, tool_use_result: { stdout: "a.txt", stderr: "" } });
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m2", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "a.txt", old_string: "x", new_string: "y" } }] } });
    out({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] }, tool_use_result: { filePath: process.cwd() + "/a.txt", structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-x", "+y"] }] } });
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m3", content: [{ type: "tool_use", id: "t3", name: "TodoWrite", input: { todos: [{ content: "Edit file", status: "completed" }, { content: "Test", status: "in_progress" }] } }] } });
    out({ type: "assistant", parent_tool_use_id: "t9", message: { id: "sub", content: [{ type: "text", text: "subagent noise" }] } });
    result();
    return;
  }
  if (text.includes("question")) {
    out({ type: "assistant", parent_tool_use_id: null, message: { id: "m4", content: [{ type: "tool_use", id: "t4", name: "AskUserQuestion", input: { questions: [{ question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "file" }, { label: "Postgres", description: "server" }] }] } }] } });
    const decision = await ask("perm-2", { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which DB?", header: "DB", multiSelect: false, options: [{ label: "SQLite", description: "file" }, { label: "Postgres", description: "server" }] }] }, tool_use_id: "t4" });
    log({ decision });
    result();
    return;
  }
  if (text.includes("steer")) { pendingSteer = true; result({ queued_turn_count: 1 }); return; }
  if (text.includes("hang")) return;
  if (text.includes("fail")) { result({ is_error: true, result: "Not logged in · Please run /login" }); return; }
  result();
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_response") {
    const resolve = waiting.get(message.response.request_id);
    waiting.delete(message.response.request_id);
    resolve?.(message.response.response);
    return;
  }
  if (message.type === "control_request") {
    log({ control: message.request });
    const respond = (response) => out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    const subtype = message.request.subtype;
    if (subtype === "initialize") respond({ models });
    else if (subtype === "list_models") respond({ models });
    else if (subtype === "get_usage") respond({ subscription_type: "pro", rate_limits: { five_hour: { utilization: 3, resets_at: null } } });
    else if (subtype === "interrupt") { respond({}); result({ subtype: "error_during_execution", is_error: true }); }
    else respond({});
    return;
  }
  if (message.type === "user") void onUser(message);
});
`;

const posixOnly = { skip: process.platform === "win32", timeout: 20_000 };

/** Puts the fake CLI on PATH and opens a provider and session against it. */
async function fakeClaude(t: test.TestContext) {
  const bin = mkdtempSync(path.join(tmpdir(), "chatroom-fake-claude-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "chatroom-claude-ws-"));
  writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(path.join(bin, "claude"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previousPath ?? "");
  const context: AgentProviderContext = {
    workspaceRoot: workspace,
    workspacePrompt: "Prefer small commits.",
    model: "test",
    reasoningEffort: "high",
    reasoningSummary: null,
    serviceTier: null,
    approvalPolicy: null,
    approvalsReviewer: null,
    permissionMode: "acceptEdits",
    continuityContext: null,
    continuityDelta: "Earlier the user asked for a README.",
  };
  const provider = new ClaudeCodeProvider(logs, {
    url: "http://127.0.0.1:9/mcp",
    token: "secret-token",
  });
  const session = await provider.createSession(context);
  t.after(async () => {
    await session.close();
    await provider.close();
    process.env.PATH = previousPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });
  const log = () =>
    readFileSync(path.join(workspace, "claude-log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, any>);
  const run = (
    text: string,
    onEvent?: (event: ProviderEvent) => Promise<void> | void,
    outputSchema: unknown = null,
  ) =>
    collect(session.runTurn({ text, attachments: [], outputSchema }), onEvent);
  const lastUserText = () =>
    log()
      .filter((entry) => entry.user)
      .at(-1)!
      .user.message.content.at(-1).text as string;
  return { provider, session, context, log, run, lastUserText };
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function collect(
  events: AsyncIterable<ProviderEvent>,
  onEvent: (event: ProviderEvent) => Promise<void> | void = () => undefined,
): Promise<ProviderEvent[]> {
  const output: ProviderEvent[] = [];
  for await (const event of events) {
    output.push(event);
    await onEvent(event);
  }
  return output;
}

function completedItems(events: ProviderEvent[]) {
  return events.filter(
    (event): event is Extract<ProviderEvent, { type: "item.completed" }> =>
      event.type === "item.completed",
  );
}

test(
  "Claude Code probe, catalog and plan usage come from the CLI",
  posixOnly,
  async (t) => {
    const { provider } = await fakeClaude(t);
    const probe = await provider.probe();
    assert.equal(probe.installed, true);
    assert.equal(probe.authenticated, true);
    assert.equal(probe.version, "9.9.9");
    assert.deepEqual(
      (await provider.listModels()).map((model) => model.id),
      ["test"],
    );
    assert.equal(
      (await provider.details()).accountUsage?.subscriptionType,
      "pro",
    );
  },
);

test(
  "Claude Code launches with session settings and keeps the MCP token out of argv",
  posixOnly,
  async (t) => {
    const { session, run, log, lastUserText } = await fakeClaude(t);
    await run("plain");
    const launch = log()[0]!;
    assert.equal(launch.token, "secret-token");
    assert.equal(launch.ask, "1");
    const args = launch.args as string[];
    assert.equal(flagValue(args, "--session-id"), session.providerSessionId);
    assert.equal(flagValue(args, "--permission-mode"), "acceptEdits");
    assert.equal(flagValue(args, "--model"), "test");
    assert.equal(flagValue(args, "--effort"), "high");
    assert.equal(flagValue(args, "--permission-prompt-tool"), "stdio");
    assert.match(
      flagValue(args, "--append-system-prompt")!,
      /Prefer small commits/,
    );
    assert.match(flagValue(args, "--mcp-config")!, /CHATROOM_AGENT_MCP_TOKEN/);
    assert.doesNotMatch(args.join(" "), /secret-token/);
    // Continuity context is prepended to the first message only.
    assert.match(
      lastUserText(),
      /Earlier the user asked for a README\.[\s\S]*plain/,
    );
    await run("again");
    assert.equal(lastUserText(), "again");
  },
);

test(
  "Claude Code maps a tool turn to ChatRoom items and usage",
  posixOnly,
  async (t) => {
    const { session, context, run, log } = await fakeClaude(t);
    const events = await run("use tools", async (event) => {
      if (event.type === "interaction.requested")
        await session.resolveInteraction(event.interaction.id, {
          type: "approval",
          decision: "acceptCommandForSession",
        });
    });

    const interaction = events.find(
      (event) => event.type === "interaction.requested",
    );
    assert.ok(interaction?.type === "interaction.requested");
    assert.equal(interaction.interaction.title, "Approve command");
    assert.deepEqual(
      interaction.interaction.approvalOptions.map((option) => option.id),
      [
        "accept",
        "acceptCommandForSession",
        "acceptToolForSession",
        "decline",
        "cancel",
      ],
    );
    const decision = log().find((entry) => entry.decision)!.decision;
    assert.equal(decision.behavior, "allow");
    assert.deepEqual(decision.updatedInput, { command: "ls" });
    assert.equal(decision.updatedPermissions[0].destination, "session");

    const completed = completedItems(events);
    const item = (id: string) =>
      completed.find((event) => event.providerItemId === id)?.item;
    assert.ok(
      events.some(
        (event) =>
          event.type === "item.delta" &&
          event.providerItemId === "block:m1:0" &&
          event.delta === "Let me",
      ),
    );
    assert.deepEqual(item("block:m1:0"), {
      type: "assistant_message",
      text: "Let me look.",
      phase: null,
    });
    assert.deepEqual(item("t1"), {
      type: "command",
      command: "ls",
      cwd: context.workspaceRoot,
      output: "a.txt",
      exitCode: 0,
    });
    assert.deepEqual(item("t2"), {
      type: "file_change",
      changes: [
        {
          path: "a.txt",
          kind: "update",
          movePath: null,
          diff: "@@ -1,1 +1,1 @@\n-x\n+y",
        },
      ],
    });
    assert.deepEqual(
      completed.find((event) => event.item.type === "plan")?.item,
      {
        type: "plan",
        text: "",
        steps: [
          { step: "Edit file", status: "completed" },
          { step: "Test", status: "inProgress" },
        ],
      },
    );
    assert.equal(
      completed.some(
        (event) =>
          event.item.type === "assistant_message" &&
          event.item.text === "subagent noise",
      ),
      false,
    );
    const usage = events.find((event) => event.type === "token.usage");
    assert.ok(usage?.type === "token.usage");
    assert.equal(usage.usage.last.inputTokens, 54);
    assert.equal(usage.usage.total.inputTokens, 100);
    assert.equal(usage.usage.modelContextWindow, 200000);
    assert.deepEqual(events.at(-1), {
      type: "turn.completed",
      status: "completed",
      error: null,
    });
  },
);

test(
  "Claude Code applies settings live and answers AskUserQuestion",
  posixOnly,
  async (t) => {
    const { session, context, run, log } = await fakeClaude(t);
    await run("plain");
    await session.configure({
      ...context,
      model: null,
      permissionMode: "plan",
      reasoningEffort: "low",
    });
    const events = await run("question", async (event) => {
      if (event.type === "interaction.requested") {
        assert.equal(event.interaction.kind, "input");
        assert.equal(event.interaction.questions[0]!.question, "Which DB?");
        await session.resolveInteraction(event.interaction.id, {
          type: "input",
          answers: { question_0: ["Postgres"] },
        });
      }
    });
    assert.equal(events.at(-1)?.type, "turn.completed");
    assert.deepEqual(
      log()
        .filter(
          (entry) => entry.control && entry.control.subtype !== "initialize",
        )
        .map((entry) => entry.control),
      [
        { subtype: "set_model" },
        { subtype: "set_permission_mode", mode: "plan" },
        { subtype: "apply_flag_settings", settings: { effortLevel: "low" } },
      ],
    );
    const answer = log()
      .filter((entry) => entry.decision)
      .at(-1)!.decision;
    assert.deepEqual(answer.updatedInput.answers, { "Which DB?": "Postgres" });
  },
);

test(
  "Claude Code steering keeps the turn open until queued sends drain",
  posixOnly,
  async (t) => {
    const { session, run, log } = await fakeClaude(t);
    const events = await run("steer", async (event) => {
      if (event.type === "turn.started")
        await session.steer!({ text: "also this", attachments: [] });
    });
    assert.equal(
      events.filter((event) => event.type === "turn.completed").length,
      1,
    );
    assert.equal(
      log()
        .filter((entry) => entry.user)
        .at(-1)!.user.priority,
      "next",
    );
  },
);

test(
  "Claude Code interrupts and failed results end the turn",
  posixOnly,
  async (t) => {
    const { session, run } = await fakeClaude(t);
    const iterator = session
      .runTurn({ text: "hang", attachments: [], outputSchema: null })
      [Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "turn.started");
    await session.interrupt();
    let last: ProviderEvent | undefined;
    for (
      let next = await iterator.next();
      !next.done;
      next = await iterator.next()
    )
      last = next.value;
    assert.deepEqual(last, {
      type: "turn.completed",
      status: "interrupted",
      error: null,
    });

    const failure = (await run("fail")).at(-1);
    assert.ok(failure?.type === "turn.completed");
    assert.equal(failure.status, "failed");
    assert.equal(failure.error?.message, "Not logged in · Please run /login");
  },
);

test(
  "Claude Code resumes with --resume and relaunches for an output schema",
  posixOnly,
  async (t) => {
    const { provider, session, context, run, log } = await fakeClaude(t);
    await run("plain");
    await session.close();
    const resumed = await provider.resumeSession(
      { ...context, continuityDelta: null },
      session.providerSessionId,
    );
    t.after(() => resumed.close());
    await collect(
      resumed.runTurn({
        text: "again",
        attachments: [],
        outputSchema: { type: "object" },
      }),
    );
    const args = log()
      .filter((entry) => entry.args)
      .at(-1)!.args as string[];
    assert.equal(flagValue(args, "--resume"), session.providerSessionId);
    assert.equal(flagValue(args, "--json-schema"), '{"type":"object"}');
  },
);
