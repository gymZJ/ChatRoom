import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "../../src/plugins/agent/types.js";
import { CodexProvider } from "../../src/plugins/agent/providers/codex/provider.js";
import { silentLogs, unusedMcpConnection } from "../helpers/agent.js";
import {
  defaultGranularApproval,
  nativeConfig,
  permissionModeValue,
} from "../../src/plugins/web/ui/utils/agent-config.js";

test("Agent forms map only advertised native permissions and reset incompatible provider modes", async () => {
  const codex = new CodexProvider(silentLogs, unusedMcpConnection);
  const providers: AgentProviderStatus[] = [codex].map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    icon: provider.icon,
    features: provider.features,
    nativeSettings: provider.nativeSettings,
    installed: true,
    authenticated: true,
    version: null,
    error: null,
    capabilities: null,
  }));
  try {
    const granular = defaultGranularApproval();
    assert.deepEqual(
      nativeConfig(
        providers,
        "codex",
        "never",
        granular,
        "user",
        "danger-full-access",
      ),
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        permissionMode: "danger-full-access",
      },
    );
    for (const provider of providers)
      for (const mode of provider.nativeSettings.find(
        (setting) => setting.id === "permissionMode",
      )!.options)
        assert.equal(permissionModeValue(null, mode.id), mode.id);
  } finally {
    await codex.close();
  }
});

test("native settings are filled and validated from each provider's declaration", async () => {
  const { applyNativeSettings, emptyAgentSessionConfig } =
    await import("../../src/plugins/agent/runtime-config.js");
  const { ClaudeCodeProvider } =
    await import("../../src/plugins/agent/providers/claude/provider.js");
  const codex = new CodexProvider(silentLogs, unusedMcpConnection);
  const claude = new ClaudeCodeProvider(silentLogs, unusedMcpConnection);
  try {
    assert.deepEqual(applyNativeSettings(codex, emptyAgentSessionConfig()), {
      ...emptyAgentSessionConfig(),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      permissionMode: "workspace-write",
    });
    assert.deepEqual(applyNativeSettings(claude, emptyAgentSessionConfig()), {
      ...emptyAgentSessionConfig(),
      permissionMode: "default",
    });
    const granular = {
      granular: {
        sandbox_approval: true,
        rules: false,
        skill_approval: true,
        request_permissions: true,
        mcp_elicitations: false,
      },
    };
    assert.deepEqual(
      applyNativeSettings(codex, {
        ...emptyAgentSessionConfig(),
        approvalPolicy: granular,
      }).approvalPolicy,
      granular,
    );
    assert.throws(
      () =>
        applyNativeSettings(codex, {
          ...emptyAgentSessionConfig(),
          approvalPolicy: {
            granular: { ...granular.granular, unknown: true },
          } as never,
        }),
      /Unsupported approvalPolicy for codex/,
    );
    assert.throws(
      () =>
        applyNativeSettings(claude, {
          ...emptyAgentSessionConfig(),
          approvalPolicy: "never",
        }),
      /claude does not support approvalPolicy/,
    );
    assert.throws(
      () =>
        applyNativeSettings(claude, {
          ...emptyAgentSessionConfig(),
          permissionMode: "workspace-write",
        }),
      /Unsupported permissionMode for claude/,
    );
  } finally {
    await codex.close();
    await claude.close();
  }
});
