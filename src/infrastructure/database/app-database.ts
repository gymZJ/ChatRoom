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

  /**
   * Rebuilds the file when most of it is free pages (e.g. after a large
   * retention prune). SQLite reuses free pages but never shrinks the file.
   */
  compactIfSparse(minFreeBytes = 64 * 1024 * 1024): boolean {
    const pragma = (name: string) =>
      Number(
        (this.raw.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[
          name
        ],
      );
    const pageSize = pragma("page_size");
    const pages = pragma("page_count");
    const free = pragma("freelist_count");
    if (free * pageSize < minFreeBytes || free * 2 < pages) return false;
    this.raw.exec("VACUUM");
    return true;
  }

  close(): void {
    this.raw.close();
  }
}
