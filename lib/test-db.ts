import pg from "pg";
import { migrate } from "./migrate.mts";

// Shared setup for *.db.test.ts. Tests read TEST_DATABASE_URL only, never
// DATABASE_URL, and reset wipes the whole public schema, so it refuses any
// database whose name doesn't say "test".

let pool: pg.Pool | undefined;

export function testPool(): pg.Pool {
  if (!pool) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is not set; see README (Tests).");
    const dbName = new URL(url).pathname.slice(1);
    if (!dbName.includes("test")) {
      throw new Error(`Refusing to reset "${dbName}": the test database name must contain "test".`);
    }
    pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  return pool;
}

// Empty schema, nothing applied.
export async function resetSchema(): Promise<pg.Pool> {
  const db = testPool();
  await db.query("drop schema public cascade; create schema public;");
  return db;
}

// Empty schema with every migration applied.
export async function freshDb(): Promise<pg.Pool> {
  const db = await resetSchema();
  await migrate(db);
  return db;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
