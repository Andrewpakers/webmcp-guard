import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGuardStorageContract } from "@webmcp-guard/shared/storage-contract";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { PACKAGE_NAME, sqliteStorage } from "./index";

const scratch = mkdtempSync(join(tmpdir(), "webmcp-guard-sqlite-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("@webmcp-guard/storage-sqlite", () => {
  it("is wired into the workspace test run", () => {
    expect(PACKAGE_NAME).toBe("@webmcp-guard/storage-sqlite");
  });

  it("persists across reopens and re-applies the schema idempotently", async () => {
    const path = join(scratch, "persist.db");

    const first = sqliteStorage({ path });
    await first.init();
    await first.createRule({ id: "kept", name: "Kept rule", match: {}, action: { type: "allow" } });
    await first.setDefaultAction("deny");
    await first.close();

    const second = sqliteStorage({ path });
    await second.init();
    await second.init();

    expect((await second.listRules()).map((rule) => rule.id)).toEqual(["kept"]);
    expect(await second.getDefaultAction()).toBe("deny");
    await second.close();
  });

  it("enables WAL on file-backed databases", async () => {
    const path = join(scratch, "wal.db");
    const storage = sqliteStorage({ path });
    await storage.init();

    const db = new Database(path, { readonly: true });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();

    await storage.close();
  });

  it("creates missing parent directories for the database file", async () => {
    const path = join(scratch, "nested", "deeper", "guard.db");
    const storage = sqliteStorage({ path });
    await storage.init();
    expect(await storage.listRules()).toEqual([]);
    await storage.close();
  });

  it("shares an existing connection without closing it", async () => {
    // How the demo portal mounts guard tables next to its own patient tables.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE patients (id TEXT PRIMARY KEY)");

    const storage = sqliteStorage({ database: db });
    await storage.init();
    await storage.createRule({ name: "Alongside", match: {}, action: { type: "allow" } });
    await storage.close();

    expect(db.open).toBe(true);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(tables).toContain("patients");
    expect(tables).toContain("guard_rules");
    expect(tables).toContain("guard_logs");
    expect(tables).toContain("guard_vault");
    expect(tables).toContain("guard_confirmations");
    db.close();
  });

  /**
   * `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, and
   * the demo portal keeps its database file across restarts — so a column added
   * in a later phase needs a real migration or every write breaks on upgrade.
   */
  it("adds columns to a guard_logs table that predates them", async () => {
    const path = join(scratch, "migrate.db");

    // A pre-Phase-5 log table: everything except justification_verdict_json.
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE guard_logs (
        id TEXT PRIMARY KEY, seq INTEGER NOT NULL, status TEXT NOT NULL,
        timestamp TEXT NOT NULL, app TEXT NOT NULL, tool TEXT NOT NULL,
        verdict TEXT NOT NULL, agent_id TEXT, agent_json TEXT NOT NULL,
        session_json TEXT, data_classes_json TEXT NOT NULL, rule_ids_json TEXT NOT NULL,
        duration_ms REAL NOT NULL, payloads_json TEXT NOT NULL, justification TEXT,
        message TEXT
      );
    `);
    legacy.close();

    const storage = sqliteStorage({ path });
    await storage.init();

    const written = await storage.appendLog({
      id: "upgraded",
      timestamp: "2026-08-29T12:00:00.000Z",
      app: "lakeside-portal",
      tool: "export_patients",
      verdict: "allow",
      agent: {},
      dataClasses: [],
      ruleIds: [],
      durationMs: 0,
      payloads: {},
      justification: "Care-gap review for Dr. Reyes.",
      justificationVerdict: { verdict: "pass", reason: "Specific enough." },
      status: "complete",
    });

    expect(written.justificationVerdict).toEqual({ verdict: "pass", reason: "Specific enough." });
    expect((await storage.getLog("upgraded"))?.justificationVerdict?.verdict).toBe("pass");
    await storage.close();
  });

  it("rejects a stored rule that no longer matches the schema", async () => {
    // Corruption (or a hand-edited row) must fail loudly, not silently feed the
    // policy engine a rule it cannot evaluate.
    const db = new Database(":memory:");
    const storage = sqliteStorage({ database: db });
    await storage.init();
    await storage.createRule({
      id: "broken",
      name: "Broken",
      match: {},
      action: { type: "allow" },
    });
    db.prepare("UPDATE guard_rules SET action_json = ? WHERE id = ?").run(
      JSON.stringify({ type: "teleport" }),
      "broken",
    );

    await expect(storage.getRule("broken")).rejects.toThrow();
    db.close();
  });
});

runGuardStorageContract("storage-sqlite (:memory:)", () => sqliteStorage({ path: ":memory:" }));
