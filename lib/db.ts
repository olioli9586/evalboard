import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";

// Anything that can run a query: the pool itself, or a client checked out of
// it for a transaction.
export type Db = pg.Pool | pg.PoolClient;

// One pool per server instance. Fluid compute reuses an instance across
// requests, so the pool outlives any one request; attachDatabasePool lets
// Vercel close idle clients before the instance is suspended.
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not configured.");
    pool = new pg.Pool({ connectionString, max: 5 });
    attachDatabasePool(pool);
  }
  return pool;
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  db: pg.Pool = getPool(),
): Promise<T> {
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch (rollbackErr) {
      // A connection that can't roll back is in an unknown state; passing the
      // error to release() destroys it instead of handing it to the next caller.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
