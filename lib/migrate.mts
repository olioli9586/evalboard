import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

// Plain-SQL migrations: every db/migrations/NNN_name.sql file runs once, in
// name order, inside its own transaction, and is recorded in
// schema_migrations with a checksum. Kept free of "@/" imports so the CLI
// (scripts/migrate.mts) can run it with plain Node.

export const MIGRATIONS_DIR = fileURLToPath(new URL("../db/migrations", import.meta.url));

// Arbitrary constant: two deploys migrating at once take turns on this lock
// instead of both applying the same file.
const LOCK_KEY = 4_812_031;

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

// Returns the names of the migrations it applied (empty when up to date).
export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const ran: string[] = [];
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), "utf8");
      const sum = checksum(sql);
      const previous = applied.get(file);
      if (previous !== undefined) {
        // Editing an applied migration would leave databases that ran the old
        // version silently different from new ones. Add a new file instead.
        if (previous !== sum) {
          throw new Error(`Migration ${file} changed after it was applied; add a new migration instead.`);
        }
        continue;
      }
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [
          file,
          sum,
        ]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      ran.push(file);
    }
    return ran;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
