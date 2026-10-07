import assert from "node:assert/strict";
import test from "node:test";
import type { AgentProviderStatus } from "../../src/plugins/agent/types.js";
import { CodexProvider } from "../../src/plugins/agent/providers/codex/provider.js";
import {
  defaultGranularApproval,
  nativeConfig,
  permissionModeValue,
} from "../../src/plugins/web/ui/utils/agent-config.js";

test("Agent forms map only advertised native permissions and reset incompatible provider modes", async () => {
  const codex = new CodexProvider({
    debug() {},
    info() {},
    warn() {},
    error() {},
  });
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
