// Apply pending migrations to DATABASE_URL: `npm run db:migrate`.
import pg from "pg";
import { migrate } from "../lib/migrate.mts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set (put it in .env.local).");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied: ${ran.join(", ")}` : "Already up to date.");
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
