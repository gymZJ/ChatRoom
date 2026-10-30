import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  agentSessionsSchema,
  DATABASE_SCHEMA,
  WORKSPACES_SCHEMA,
} from "./schema.js";

const SCHEMA_VERSION = 1;

export function initializeDatabase(database: DatabaseSync): void {
  const version = (
    database.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (version > SCHEMA_VERSION)
    throw new Error(`Unsupported newer ChatRoom database schema: ${version}`);

  const columns = database
    .prepare("PRAGMA table_info(agent_sessions)")
    .all() as {
    name: string;
  }[];
  const legacySessions = columns.some(
    (column) => column.name === "workspace_root",
  );
  if (
    columns.length > 0 &&
    !legacySessions &&
    !columns.some((column) => column.name === "workspace_id")
  )
    throw new Error("Unrecognized ChatRoom agent_sessions schema");

  // Rebuilding a referenced table requires foreign keys to be disabled before
  // entering the transaction. The transaction keeps the old database intact
  // if any migration or schema initialization step fails.
  database.exec(`PRAGMA foreign_keys = ${legacySessions ? "OFF" : "ON"};`);
  try {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (legacySessions) migrateLegacySessions(database);
      database.exec(DATABASE_SCHEMA);
      if (legacySessions) {
        const invalidReferences = database
          .prepare("PRAGMA foreign_key_check")
          .all();
        if (invalidReferences.length)
          throw new Error("Database migration failed foreign-key validation");
      }
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function migrateLegacySessions(database: DatabaseSync): void {
  database.exec(WORKSPACES_SCHEMA);

  const roots = database
    .prepare("SELECT DISTINCT workspace_root FROM agent_sessions")
    .all() as { workspace_root: string }[];
  const insertWorkspace = database.prepare(
    "INSERT INTO workspaces(id, path, manually_registered, state) VALUES(?, ?, 1, 'available') ON CONFLICT(path) DO NOTHING",
  );
  for (const { workspace_root } of roots)
    insertWorkspace.run(`ws_${randomUUID()}`, workspace_root);

  database.exec(agentSessionsSchema("agent_sessions_next"));
  database.exec(`
    INSERT INTO agent_sessions_next(id, workspace_id, provider, status, created_at, updated_at)
    SELECT s.id, w.id, s.provider, s.status, s.created_at, s.updated_at
    FROM agent_sessions s
    JOIN workspaces w ON w.path = s.workspace_root;
  `);

  const oldCount = (
    database.prepare("SELECT COUNT(*) AS count FROM agent_sessions").get() as {
      count: number;
    }
  ).count;
  const newCount = (
    database
      .prepare("SELECT COUNT(*) AS count FROM agent_sessions_next")
      .get() as {
      count: number;
    }
  ).count;
  if (oldCount !== newCount)
    throw new Error("Database migration would lose Agent sessions");

  database.exec("DROP TABLE agent_sessions;");
  database.exec("ALTER TABLE agent_sessions_next RENAME TO agent_sessions;");
}
