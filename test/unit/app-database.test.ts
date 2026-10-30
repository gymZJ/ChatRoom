import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AppDatabase } from "../../src/infrastructure/database/app-database.js";

test("AppDatabase initializes and reopens the current schema", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-db-"));
  const filename = path.join(root, "app.sqlite");
  try {
    const database = new AppDatabase(filename);
    database.raw.exec(
      "INSERT INTO web_sessions VALUES ('persisted', 'expiry', 'created')",
    );
    database.close();

    const reopened = new AppDatabase(filename);
    try {
      assert.equal(
        reopened.raw.prepare("SELECT token_hash FROM web_sessions").get()
          ?.token_hash,
        "persisted",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AppDatabase upgrades 1.2.0 sessions without losing related data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-migration-"));
  const filename = path.join(root, "app.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      readFileSync(
        new URL("../fixtures/schema-v1.2.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy.exec("PRAGMA foreign_keys = ON");
    const insertSession = legacy.prepare(
      "INSERT INTO agent_sessions(id, workspace_root, provider, status, created_at, updated_at) VALUES(?, ?, 'codex', 'idle', 'created', 'updated')",
    );
    insertSession.run("session-a", path.join(root, "project-a"));
    insertSession.run("session-b", path.join(root, "project-a"));
    insertSession.run("session-c", path.join(root, "project-b"));
    legacy
      .prepare(
        "INSERT INTO agent_turns(id, session_id, provider, origin, status, error_json, started_at) VALUES(?, ?, 'codex', 0, 'completed', 'null', 'started')",
      )
      .run("turn-a", "session-a");
    legacy
      .prepare(
        "INSERT INTO agent_items(id, turn_id, type, sequence, status, payload_json, created_at, updated_at) VALUES(?, ?, 'message', 0, 'completed', ?, 'created', 'updated')",
      )
      .run("item-a", "turn-a", '{"content":"keep me"}');
    legacy
      .prepare(
        "INSERT INTO agent_session_providers(session_id, provider, provider_session_id, created_at, updated_at) VALUES(?, 'codex', ?, 'created', 'updated')",
      )
      .run("session-a", "provider-state-a");
    legacy
      .prepare(
        "INSERT INTO custom_mcp_servers(id, name, config_json, enabled, created_at, updated_at) VALUES('custom', 'server', '{}', 1, 'created', 'updated')",
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO web_sessions(token_hash, expires_at, created_at) VALUES('token', 'expiry', 'created')",
      )
      .run();
    legacy.close();

    for (let opening = 0; opening < 2; opening++) {
      const database = new AppDatabase(filename);
      try {
        const sessions = database.raw
          .prepare(
            "SELECT s.id, w.path, s.provider, s.status, s.created_at, s.updated_at FROM agent_sessions s JOIN workspaces w ON s.workspace_id=w.id ORDER BY s.id",
          )
          .all() as Array<{ id: string; path: string }>;
        assert.deepEqual(
          sessions.map((s) => [s.id, s.path]),
          [
            ["session-a", path.join(root, "project-a")],
            ["session-b", path.join(root, "project-a")],
            ["session-c", path.join(root, "project-b")],
          ],
        );
        assert.equal(
          database.raw.prepare("SELECT COUNT(*) AS count FROM workspaces").get()
            ?.count,
          2,
        );
        assert.equal(
          database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM workspaces WHERE manually_registered=1",
            )
            .get()?.count,
          2,
        );
        assert.equal(
          database.raw
            .prepare("SELECT provider_session_id FROM agent_session_providers")
            .get()?.provider_session_id,
          "provider-state-a",
        );
        assert.equal(
          database.raw.prepare("SELECT payload_json FROM agent_items").get()
            ?.payload_json,
          '{"content":"keep me"}',
        );
        assert.equal(
          database.raw.prepare("SELECT name FROM custom_mcp_servers").get()
            ?.name,
          "server",
        );
        assert.equal(
          database.raw.prepare("SELECT token_hash FROM web_sessions").get()
            ?.token_hash,
          "token",
        );
        assert.deepEqual(
          database.raw.prepare("PRAGMA foreign_key_check").all(),
          [],
        );
        assert.equal(
          database.raw.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
          1,
        );
        assert.equal(
          database.raw.prepare("PRAGMA user_version").get()?.user_version,
          1,
        );
        assert.equal(
          database.raw
            .prepare(
              "SELECT COUNT(*) AS count FROM pragma_index_list('agent_sessions') WHERE name='agent_sessions_workspace_idx'",
            )
            .get()?.count,
          1,
        );
      } finally {
        database.close();
      }
    }

    const database = new AppDatabase(filename);
    try {
      database.raw
        .prepare("DELETE FROM agent_sessions WHERE id='session-a'")
        .run();
      assert.equal(
        database.raw.prepare("SELECT COUNT(*) AS count FROM agent_turns").get()
          ?.count,
        0,
      );
      assert.equal(
        database.raw.prepare("SELECT COUNT(*) AS count FROM agent_items").get()
          ?.count,
        0,
      );
      assert.equal(
        database.raw
          .prepare("SELECT COUNT(*) AS count FROM agent_session_providers")
          .get()?.count,
        0,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AppDatabase initializes missing tables for databases preceding Agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-migration-"));
  const filename = path.join(root, "app.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      "CREATE TABLE web_sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    legacy.exec(
      "INSERT INTO web_sessions VALUES('old-token', 'expiry', 'created')",
    );
    legacy.close();
    const upgraded = new AppDatabase(filename);
    try {
      assert.equal(
        upgraded.raw.prepare("SELECT token_hash FROM web_sessions").get()
          ?.token_hash,
        "old-token",
      );
      assert.deepEqual(
        upgraded.raw.prepare("SELECT * FROM agent_sessions").all(),
        [],
      );
      assert.deepEqual(
        upgraded.raw.prepare("SELECT * FROM workspaces").all(),
        [],
      );
    } finally {
      upgraded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AppDatabase rolls back a migration that violates existing references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatroom-migration-"));
  const filename = path.join(root, "app.sqlite");
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      readFileSync(
        new URL("../fixtures/schema-v1.2.sql", import.meta.url),
        "utf8",
      ),
    );
    legacy.exec("PRAGMA foreign_keys = OFF");
    legacy.exec(
      "INSERT INTO agent_sessions VALUES('session-a', '/project', 'codex', 'idle', 'created', 'updated')",
    );
    legacy.exec(
      "INSERT INTO agent_turns(id, session_id, provider, origin, status, error_json, started_at) VALUES('orphan', 'missing', 'codex', 0, 'completed', 'null', 'started')",
    );
    legacy.close();

    assert.throws(() => new AppDatabase(filename), /foreign-key validation/);
    const original = new DatabaseSync(filename);
    try {
      const columns = original
        .prepare("PRAGMA table_info(agent_sessions)")
        .all() as Array<{ name: string }>;
      assert(columns.some((column) => column.name === "workspace_root"));
      assert(!columns.some((column) => column.name === "workspace_id"));
      assert.equal(
        original.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get()
          ?.count,
        1,
      );
      assert.equal(
        original.prepare("PRAGMA user_version").get()?.user_version,
        0,
      );
      assert.equal(
        original
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='agent_sessions_next'",
          )
          .get()?.count,
        0,
      );
    } finally {
      original.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
