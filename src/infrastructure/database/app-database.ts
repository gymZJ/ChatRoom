import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeDatabase } from "./migrate.js";

export class AppDatabase {
  readonly raw: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(databasePath);
    try {
      this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      initializeDatabase(this.raw);
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  close(): void {
    this.raw.close();
  }
}
