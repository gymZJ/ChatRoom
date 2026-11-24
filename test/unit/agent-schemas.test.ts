import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  configurationPatch,
  reviewTargetSchema,
  settingsPatchShape,
  settingsSchemas,
} from "../../src/plugins/agent/schemas.js";

test("shared Agent schemas reject blank review targets and unknown fields", () => {
  assert.deepEqual(reviewTargetSchema.parse({ type: "commit", sha: "abc" }), {
    type: "commit",
    sha: "abc",
    title: null,
  });
  for (const invalid of [
    { type: "baseBranch", branch: "  " },
    { type: "custom", instructions: "" },
    { type: "uncommittedChanges", extra: true },
    { type: "unknown" },
  ])
    assert.equal(reviewTargetSchema.safeParse(invalid).success, false);

  const granular = {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true,
  };
  assert.equal(
    settingsSchemas.approvalPolicy.safeParse({ granular }).success,
    true,
  );
  assert.equal(
    settingsSchemas.approvalPolicy.safeParse({
      granular: { ...granular, extra: true },
    }).success,
    false,
  );
});

test("settings patches keep omitted fields out and null resets in", () => {
  const patch = z
    .object(settingsPatchShape)
    .parse({ model: null, permissionMode: "plan" });
  assert.deepEqual(configurationPatch(patch), {
    model: null,
    permissionMode: "plan",
  });
});
