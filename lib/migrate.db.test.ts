import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, MIGRATIONS_DIR } from "./migrate.mts";
import { closeTestPool, resetSchema } from "./test-db";

afterAll(closeTestPool);

describe("migrate", () => {
  it("applies every migration once, then is a no-op", async () => {
    const db = await resetSchema();
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    expect(await migrate(db)).toEqual(files);
    expect(await migrate(db)).toEqual([]);

    const { rows } = await db.query("select name from schema_migrations order by name");
    expect(rows.map((r) => r.name)).toEqual(files);
    const tables = await db.query(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["cases", "datasets", "results", "runs", "usage_daily"]),
    );
  });

  it("is safe when two runners start at the same time", async () => {
    const db = await resetSchema();
    const [a, b] = await Promise.all([migrate(db), migrate(db)]);
    // The advisory lock serializes them: one applies everything, the other nothing.
    expect([a.length, b.length].sort()).toEqual([0, (await readdir(MIGRATIONS_DIR)).length]);
  });

  describe("with a scratch migrations folder", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "evalboard-mig-"));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("refuses to run when an applied migration was edited", async () => {
      const db = await resetSchema();
      await writeFile(path.join(dir, "001_a.sql"), "create table a (id int);");
      await migrate(db, dir);

      await writeFile(path.join(dir, "001_a.sql"), "create table a (id bigint);");
      await expect(migrate(db, dir)).rejects.toThrow(/changed after it was applied/);
    });

    it("rolls back a failing migration and records nothing for it", async () => {
      const db = await resetSchema();
      await writeFile(path.join(dir, "001_ok.sql"), "create table ok (id int);");
      await writeFile(path.join(dir, "002_bad.sql"), "create table half (id int); select nope;");

      await expect(migrate(db, dir)).rejects.toThrow(/002_bad.sql failed/);

      const { rows } = await db.query("select name from schema_migrations");
      expect(rows.map((r) => r.name)).toEqual(["001_ok.sql"]);
      const half = await db.query("select to_regclass('public.half') as t");
      expect(half.rows[0].t).toBeNull();
    });
  });
});
