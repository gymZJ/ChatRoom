import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
