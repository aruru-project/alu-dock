import type { DatabaseSync } from "node:sqlite";

/*
 * Transactions on the assistant service's writing connection, shared by her memories and her timeline,
 * which keep their rows in the conversations' database (store.ts).
 */

/** Runs `work` as one write transaction. */
export function writeTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* SQLite already rolled back */ }
    throw error;
  }
}

/** Several reads that should agree, in one read transaction; inside a transaction already, they just read. */
export function readTransaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec("BEGIN");
  try { return work(); }
  finally { if (db.isTransaction) db.exec("COMMIT"); }
}
