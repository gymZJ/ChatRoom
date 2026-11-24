import assert from "node:assert/strict";
import test from "node:test";
import { pageAgentHistory } from "../../src/plugins/agent/runtime-state.js";
import type { AgentHistory } from "../../src/plugins/agent/types.js";

function history(count: number): AgentHistory {
  return {
    session: { id: "s" } as AgentHistory["session"],
    turns: Array.from({ length: count }, (_, index) => ({
      turn: { id: "t" + (index + 1) } as AgentHistory["turns"][number]["turn"],
      items: [],
    })),
  };
}

const ids = (page: { turns: AgentHistory["turns"] }) =>
  page.turns.map(({ turn }) => turn.id);

test("Agent history pages return the newest turns and page in both directions", () => {
  const all = history(5);
  const latest = pageAgentHistory(all, {
    limit: 2,
    beforeTurnId: null,
    afterTurnId: null,
  });
  assert.deepEqual(ids(latest), ["t4", "t5"]);
  assert.equal(latest.totalTurns, 5);
  assert.equal(latest.hasEarlierTurns, true);
  assert.equal(latest.hasLaterTurns, false);

  const older = pageAgentHistory(all, {
    limit: 2,
    beforeTurnId: "t4",
    afterTurnId: null,
  });
  assert.deepEqual(ids(older), ["t2", "t3"]);
  assert.equal(older.hasEarlierTurns, true);
  assert.equal(older.hasLaterTurns, true);

  const newer = pageAgentHistory(all, {
    limit: 2,
    beforeTurnId: null,
    afterTurnId: "t1",
  });
  assert.deepEqual(ids(newer), ["t2", "t3"]);
  assert.equal(newer.hasLaterTurns, true);

  const caughtUp = pageAgentHistory(all, {
    limit: 10,
    beforeTurnId: null,
    afterTurnId: "t5",
  });
  assert.deepEqual(ids(caughtUp), []);
  assert.equal(caughtUp.hasLaterTurns, false);

  assert.throws(
    () =>
      pageAgentHistory(all, {
        limit: 2,
        beforeTurnId: "missing",
        afterTurnId: null,
      }),
    /Unknown Agent turn/,
  );
});
