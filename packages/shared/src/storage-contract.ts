import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POLICY_VERSION, RuleSchema, type Rule } from "./policy";
import {
  GuardStorageError,
  LOG_QUERY_MAX_LIMIT,
  LogRecordSchema,
  type GuardStorage,
  type LogRecord,
  type VaultEntry,
} from "./storage";

/**
 * The `GuardStorage` conformance kit.
 *
 * `docs/10-agent-operations.md` requires one storage contract suite run against
 * both bundled adapters; this is that suite. It is exported from
 * `@webmcp-guard/shared/storage-contract` so anyone writing a third adapter
 * ("bring your own database", `docs/04-sdk-requirements.md`) can prove theirs
 * behaves identically in three lines of test code:
 *
 * ```ts
 * import { runGuardStorageContract } from "@webmcp-guard/shared/storage-contract";
 * runGuardStorageContract("my-adapter", () => myStorage({ ... }));
 * ```
 *
 * The kit imports `vitest`, which is why it is a separate module from the
 * package entry point — nothing here is reachable from a browser bundle.
 */

/** Produces a fresh, empty store. The kit calls `init()` and `close()` itself. */
export type GuardStorageFactory = () => GuardStorage | Promise<GuardStorage>;

const APP = "lakeside-portal";

function ruleDraft(overrides: Partial<Rule> = {}) {
  return {
    name: "Test rule",
    match: {},
    action: { type: "allow" } as const,
    ...overrides,
  };
}

function logRecord(overrides: Partial<LogRecord> & { id: string }): LogRecord {
  return {
    timestamp: "2026-08-29T12:00:00.000Z",
    app: APP,
    tool: "search_patients",
    verdict: "allow",
    agent: {},
    dataClasses: [],
    ruleIds: [],
    durationMs: 0,
    payloads: { argsBefore: {}, argsAfter: {}, resultBefore: null, resultAfter: null },
    status: "complete",
    ...overrides,
  };
}

function vaultEntry(overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    token: "tok_ssn_8f3a2c19",
    dataClass: "ssn",
    ciphertext: "Y2lwaGVy",
    iv: "aXYxMjM0NTY3ODkwMTI=",
    authTag: "dGFn",
    firstSeenAt: "2026-08-29T12:00:00.000Z",
    ...overrides,
  };
}

export function runGuardStorageContract(name: string, createStorage: GuardStorageFactory): void {
  describe(`GuardStorage contract (${name})`, () => {
    let storage: GuardStorage;

    beforeEach(async () => {
      storage = await createStorage();
      await storage.init();
    });

    afterEach(async () => {
      await storage.close();
    });

    describe("lifecycle", () => {
      it("init is idempotent", async () => {
        await storage.init();
        await storage.init();
        expect(await storage.listRules()).toEqual([]);
      });

      it("close is idempotent", async () => {
        await storage.close();
        await storage.close();
      });

      it("starts empty with an allow baseline", async () => {
        expect(await storage.listRules()).toEqual([]);
        expect(await storage.getDefaultAction()).toBe("allow");
        expect(await storage.getPolicy()).toEqual({
          version: POLICY_VERSION,
          defaultAction: "allow",
          rules: [],
        });
      });
    });

    describe("rules", () => {
      it("keeps a supplied id and defaults enabled to true", async () => {
        const created = await storage.createRule(ruleDraft({ id: "phi-transform-default" }));
        expect(created.id).toBe("phi-transform-default");
        expect(created.enabled).toBe(true);
        expect(RuleSchema.parse(created)).toEqual(created);
      });

      it("generates an id when none is supplied", async () => {
        const a = await storage.createRule(ruleDraft({ name: "One" }));
        const b = await storage.createRule(ruleDraft({ name: "Two" }));
        expect(a.id).toBeTruthy();
        expect(b.id).toBeTruthy();
        expect(a.id).not.toBe(b.id);
      });

      it("appends new rules after existing ones by priority", async () => {
        const first = await storage.createRule(ruleDraft({ id: "a" }));
        const second = await storage.createRule(ruleDraft({ id: "b" }));
        expect(second.priority).toBeGreaterThan(first.priority);
      });

      it("rejects a duplicate id", async () => {
        await storage.createRule(ruleDraft({ id: "dup" }));
        await expect(storage.createRule(ruleDraft({ id: "dup" }))).rejects.toBeInstanceOf(
          GuardStorageError,
        );
        await expect(storage.createRule(ruleDraft({ id: "dup" }))).rejects.toMatchObject({
          code: "duplicate-rule",
        });
        expect(await storage.listRules()).toHaveLength(1);
      });

      it("orders by priority ascending, ties by insertion order", async () => {
        await storage.createRule(ruleDraft({ id: "late", priority: 30 }));
        await storage.createRule(ruleDraft({ id: "tie-first", priority: 10 }));
        await storage.createRule(ruleDraft({ id: "tie-second", priority: 10 }));
        await storage.createRule(ruleDraft({ id: "negative", priority: -5 }));

        expect((await storage.listRules()).map((rule) => rule.id)).toEqual([
          "negative",
          "tie-first",
          "tie-second",
          "late",
        ]);
      });

      it("round-trips every rule field", async () => {
        const draft = ruleDraft({
          id: "full",
          name: "Tokenize PHI",
          enabled: false,
          priority: 42,
          match: {
            apps: [APP],
            tools: { tags: ["phi"] },
            agents: [{ kind: "browser", brand: "Chromium", minVersion: 140 }],
            roles: ["clinician"],
            dataClasses: ["ssn", "mrn"],
          },
          action: {
            type: "transform",
            perClass: {
              ssn: "tokenize",
              mrn: "tokenize",
              name: "tokenize",
              dob: "contextualize",
              phone: "passthrough",
              email: "passthrough",
              address: "contextualize",
              insurance_id: "tokenize",
              credit_card: "mask",
              free_text_phi: "passthrough",
            },
          },
        });

        const created = await storage.createRule(draft);
        expect(created).toEqual({ ...draft, id: "full", enabled: false, priority: 42 });
        expect(await storage.getRule("full")).toEqual(created);
      });

      it("returns null for an unknown rule", async () => {
        expect(await storage.getRule("nope")).toBeNull();
      });

      it("updates individual fields and leaves the rest alone", async () => {
        await storage.createRule(ruleDraft({ id: "r1", name: "Before", priority: 10 }));

        const disabled = await storage.updateRule("r1", { enabled: false });
        expect(disabled).toMatchObject({ id: "r1", name: "Before", enabled: false, priority: 10 });

        const renamed = await storage.updateRule("r1", {
          name: "After",
          action: { type: "deny", message: "no" },
        });
        expect(renamed).toMatchObject({
          name: "After",
          enabled: false,
          action: { type: "deny", message: "no" },
        });

        const reprioritized = await storage.updateRule("r1", {
          priority: 99,
          match: { apps: ["x"] },
        });
        expect(reprioritized).toMatchObject({ priority: 99, match: { apps: ["x"] } });
        expect(await storage.getRule("r1")).toEqual(reprioritized);
      });

      it("returns null when updating an unknown rule", async () => {
        expect(await storage.updateRule("nope", { enabled: false })).toBeNull();
      });

      it("deletes rules and reports whether anything was removed", async () => {
        await storage.createRule(ruleDraft({ id: "gone" }));
        expect(await storage.deleteRule("gone")).toBe(true);
        expect(await storage.deleteRule("gone")).toBe(false);
        expect(await storage.getRule("gone")).toBeNull();
        expect(await storage.listRules()).toEqual([]);
      });

      it("reorders rules into the requested order", async () => {
        await storage.createRule(ruleDraft({ id: "a" }));
        await storage.createRule(ruleDraft({ id: "b" }));
        await storage.createRule(ruleDraft({ id: "c" }));

        const reordered = await storage.reorderRules(["c", "a", "b"]);
        expect(reordered.map((rule) => rule.id)).toEqual(["c", "a", "b"]);
        expect((await storage.listRules()).map((rule) => rule.id)).toEqual(["c", "a", "b"]);
        const priorities = reordered.map((rule) => rule.priority);
        expect([...priorities].sort((x, y) => x - y)).toEqual(priorities);
      });

      it("moves unlisted rules to the end, preserving their relative order", async () => {
        await storage.createRule(ruleDraft({ id: "a" }));
        await storage.createRule(ruleDraft({ id: "b" }));
        await storage.createRule(ruleDraft({ id: "c" }));

        const reordered = await storage.reorderRules(["c"]);
        expect(reordered.map((rule) => rule.id)).toEqual(["c", "a", "b"]);
      });

      it("rejects an unknown or duplicated id without changing anything", async () => {
        await storage.createRule(ruleDraft({ id: "a" }));
        await storage.createRule(ruleDraft({ id: "b" }));

        await expect(storage.reorderRules(["a", "nope"])).rejects.toMatchObject({
          code: "unknown-rule",
        });
        await expect(storage.reorderRules(["a", "a"])).rejects.toMatchObject({
          code: "invalid-argument",
        });
        expect((await storage.listRules()).map((rule) => rule.id)).toEqual(["a", "b"]);
      });

      it("does not let callers mutate stored state through returned objects", async () => {
        const created = await storage.createRule(
          ruleDraft({ id: "frozen", match: { apps: [APP] } }),
        );
        created.name = "hacked";
        (created.match.apps as string[]).push("other-app");

        expect(await storage.getRule("frozen")).toMatchObject({
          name: "Test rule",
          match: { apps: [APP] },
        });
      });

      it("reads back the default action that was set", async () => {
        await storage.setDefaultAction("deny");
        expect(await storage.getDefaultAction()).toBe("deny");
        expect((await storage.getPolicy()).defaultAction).toBe("deny");

        await storage.setDefaultAction("allow");
        expect(await storage.getDefaultAction()).toBe("allow");
      });

      it("exposes the ordered rules through getPolicy", async () => {
        await storage.createRule(ruleDraft({ id: "second", priority: 20 }));
        await storage.createRule(ruleDraft({ id: "first", priority: 10 }));

        const policy = await storage.getPolicy();
        expect(policy.version).toBe(POLICY_VERSION);
        expect(policy.rules.map((rule) => rule.id)).toEqual(["first", "second"]);
      });
    });

    describe("logs", () => {
      it("round-trips an entry", async () => {
        const entry = logRecord({
          id: "call-1",
          tool: "get_patient",
          verdict: "deny",
          agent: {
            agentId: "chatgpt-atlas",
            browserBrand: "Chromium",
            browserVersion: "149",
            platform: "macOS",
            userAgent: "Mozilla/5.0",
            isSecureContext: true,
          },
          session: { userId: "u-1", role: "clinician" },
          dataClasses: ["ssn", "name"],
          ruleIds: ["r1", "r2"],
          durationMs: 12.5,
          payloads: {
            argsBefore: { mrn: "LM-100001" },
            argsAfter: { mrn: "LM-100001" },
            resultBefore: { ssn: "123-45-6789" },
            resultAfter: { ssn: "tok_ssn_8f3a2c19" },
          },
          justification: "Refill request from the patient",
          message: "Blocked by policy",
        });

        const written = await storage.appendLog(entry);
        expect(written).toEqual(entry);

        const read = await storage.getLog("call-1");
        expect(read).toEqual(entry);
        expect(LogRecordSchema.parse(read)).toEqual(entry);
      });

      it("returns null for an unknown id", async () => {
        expect(await storage.getLog("nope")).toBeNull();
      });

      it("rejects a duplicate entry id", async () => {
        await storage.appendLog(logRecord({ id: "call-1" }));
        await expect(storage.appendLog(logRecord({ id: "call-1" }))).rejects.toMatchObject({
          code: "invalid-argument",
        });
      });

      it("drops undefined payload halves rather than storing them", async () => {
        await storage.appendLog(
          logRecord({
            id: "pending-1",
            status: "pending",
            payloads: {
              argsBefore: { q: "hyper" },
              argsAfter: { q: "hyper" },
            } as LogRecord["payloads"],
          }),
        );

        const stored = await storage.getLog("pending-1");
        expect(stored?.payloads.argsBefore).toEqual({ q: "hyper" });
        expect(stored?.payloads.resultBefore).toBeUndefined();
        expect(stored?.payloads.resultAfter).toBeUndefined();
      });

      it("completes a pending entry, merging payloads", async () => {
        await storage.appendLog(
          logRecord({
            id: "call-2",
            status: "pending",
            durationMs: 0,
            ruleIds: ["gate-rule"],
            payloads: {
              argsBefore: { q: "hyper" },
              argsAfter: { q: "hyper" },
            } as LogRecord["payloads"],
          }),
        );

        const completed = await storage.completeLog("call-2", {
          durationMs: 31,
          dataClasses: ["name"],
          ruleIds: ["gate-rule", "transform-rule"],
          payloads: { resultBefore: { name: "Ada" }, resultAfter: { name: "tok_name_1234abcd" } },
        });

        expect(completed).toMatchObject({
          id: "call-2",
          status: "complete",
          durationMs: 31,
          dataClasses: ["name"],
          ruleIds: ["gate-rule", "transform-rule"],
          payloads: {
            argsBefore: { q: "hyper" },
            argsAfter: { q: "hyper" },
            resultBefore: { name: "Ada" },
            resultAfter: { name: "tok_name_1234abcd" },
          },
        });
        expect(await storage.getLog("call-2")).toEqual(completed);
      });

      it("completes at most once, and never an unknown entry", async () => {
        await storage.appendLog(logRecord({ id: "call-3", status: "pending" }));

        expect(await storage.completeLog("call-3", { durationMs: 5 })).not.toBeNull();
        expect(await storage.completeLog("call-3", { durationMs: 9999 })).toBeNull();
        expect(await storage.completeLog("never-gated", { durationMs: 1 })).toBeNull();

        expect(await storage.getLog("call-3")).toMatchObject({ durationMs: 5, status: "complete" });
      });

      it("can change the verdict and message while completing", async () => {
        await storage.appendLog(logRecord({ id: "call-4", status: "pending", verdict: "allow" }));

        const completed = await storage.completeLog("call-4", {
          verdict: "deny",
          message: "Blocked late",
          justification: "because",
        });

        expect(completed).toMatchObject({
          verdict: "deny",
          message: "Blocked late",
          justification: "because",
        });
      });

      describe("queryLogs", () => {
        beforeEach(async () => {
          await storage.appendLog(
            logRecord({
              id: "log-1",
              timestamp: "2026-08-27T09:00:00.000Z",
              tool: "search_patients",
              verdict: "allow",
              dataClasses: ["name"],
              agent: { agentId: "chatgpt-atlas" },
            }),
          );
          await storage.appendLog(
            logRecord({
              id: "log-2",
              timestamp: "2026-08-28T09:00:00.000Z",
              tool: "delete_patient",
              verdict: "deny",
              agent: { agentId: "chatgpt-atlas" },
            }),
          );
          await storage.appendLog(
            logRecord({
              id: "log-3",
              timestamp: "2026-08-28T09:00:00.000Z",
              tool: "export_patients",
              verdict: "require-justification",
              dataClasses: ["ssn", "name"],
              agent: { agentId: "unknown-agent" },
              app: "other-app",
            }),
          );
          await storage.appendLog(
            logRecord({ id: "log-4", timestamp: "2026-08-29T09:00:00.000Z", status: "pending" }),
          );
        });

        it("returns everything newest first, ties by insertion order", async () => {
          const page = await storage.queryLogs();
          expect(page.entries.map((entry) => entry.id)).toEqual([
            "log-4",
            "log-3",
            "log-2",
            "log-1",
          ]);
          expect(page.total).toBe(4);
          expect(page.nextCursor).toBeUndefined();
        });

        it("filters by tool, verdict, app, agent, status and data class", async () => {
          const byTool = await storage.queryLogs({ tool: "delete_patient" });
          expect(byTool.entries.map((entry) => entry.id)).toEqual(["log-2"]);
          expect(byTool.total).toBe(1);

          const byVerdict = await storage.queryLogs({ verdict: "deny" });
          expect(byVerdict.entries.map((entry) => entry.id)).toEqual(["log-2"]);

          const byApp = await storage.queryLogs({ app: "other-app" });
          expect(byApp.entries.map((entry) => entry.id)).toEqual(["log-3"]);

          const byAgent = await storage.queryLogs({ agentId: "chatgpt-atlas" });
          expect(byAgent.entries.map((entry) => entry.id)).toEqual(["log-2", "log-1"]);

          const byStatus = await storage.queryLogs({ status: "pending" });
          expect(byStatus.entries.map((entry) => entry.id)).toEqual(["log-4"]);

          const byClass = await storage.queryLogs({ dataClass: "name" });
          expect(byClass.entries.map((entry) => entry.id)).toEqual(["log-3", "log-1"]);

          const bySsn = await storage.queryLogs({ dataClass: "ssn" });
          expect(bySsn.entries.map((entry) => entry.id)).toEqual(["log-3"]);
        });

        it("combines filters with AND", async () => {
          const page = await storage.queryLogs({ agentId: "chatgpt-atlas", verdict: "allow" });
          expect(page.entries.map((entry) => entry.id)).toEqual(["log-1"]);
        });

        it("treats time bounds as inclusive", async () => {
          const since = await storage.queryLogs({ since: "2026-08-28T09:00:00.000Z" });
          expect(since.entries.map((entry) => entry.id)).toEqual(["log-4", "log-3", "log-2"]);

          const until = await storage.queryLogs({ until: "2026-08-28T09:00:00.000Z" });
          expect(until.entries.map((entry) => entry.id)).toEqual(["log-3", "log-2", "log-1"]);

          const window = await storage.queryLogs({
            since: "2026-08-28T00:00:00.000Z",
            until: "2026-08-28T23:59:59.999Z",
          });
          expect(window.entries.map((entry) => entry.id)).toEqual(["log-3", "log-2"]);
        });

        it("returns an empty page when nothing matches", async () => {
          const page = await storage.queryLogs({ tool: "nonexistent" });
          expect(page).toEqual({ entries: [], total: 0 });
        });

        it("paginates by offset while reporting the unpaginated total", async () => {
          const first = await storage.queryLogs({ limit: 2 });
          expect(first.entries.map((entry) => entry.id)).toEqual(["log-4", "log-3"]);
          expect(first.total).toBe(4);
          expect(first.nextCursor).toBeTruthy();

          const second = await storage.queryLogs({ limit: 2, offset: 2 });
          expect(second.entries.map((entry) => entry.id)).toEqual(["log-2", "log-1"]);
          expect(second.total).toBe(4);
          expect(second.nextCursor).toBeUndefined();

          const past = await storage.queryLogs({ limit: 2, offset: 99 });
          expect(past.entries).toEqual([]);
          expect(past.total).toBe(4);
        });

        it("paginates by cursor, including across a timestamp tie", async () => {
          const first = await storage.queryLogs({ limit: 2 });
          expect(first.nextCursor).toBeDefined();

          const second = await storage.queryLogs({ limit: 2, cursor: first.nextCursor });
          expect(second.entries.map((entry) => entry.id)).toEqual(["log-2", "log-1"]);
          expect(second.nextCursor).toBeUndefined();
        });

        it("keeps cursor pages consistent with the active filters", async () => {
          const first = await storage.queryLogs({ agentId: "chatgpt-atlas", limit: 1 });
          expect(first.entries.map((entry) => entry.id)).toEqual(["log-2"]);

          const second = await storage.queryLogs({
            agentId: "chatgpt-atlas",
            limit: 1,
            cursor: first.nextCursor,
          });
          expect(second.entries.map((entry) => entry.id)).toEqual(["log-1"]);
        });

        it("ignores an unparsable cursor instead of failing the query", async () => {
          const page = await storage.queryLogs({ cursor: "not-a-cursor", limit: 2 });
          expect(page.entries.map((entry) => entry.id)).toEqual(["log-4", "log-3"]);
        });

        it("clamps the page size", async () => {
          expect((await storage.queryLogs({ limit: 0 })).entries).toHaveLength(1);
          expect(
            (await storage.queryLogs({ limit: LOG_QUERY_MAX_LIMIT + 500 })).entries,
          ).toHaveLength(4);
        });
      });
    });

    describe("stats", () => {
      beforeEach(async () => {
        await storage.appendLog(
          logRecord({
            id: "s-1",
            timestamp: "2026-08-27T09:00:00.000Z",
            tool: "search_patients",
            verdict: "allow",
            dataClasses: ["name"],
            agent: { agentId: "chatgpt-atlas" },
          }),
        );
        await storage.appendLog(
          logRecord({
            id: "s-2",
            timestamp: "2026-08-28T09:00:00.000Z",
            tool: "search_patients",
            verdict: "allow",
            agent: { agentId: "chatgpt-atlas" },
          }),
        );
        await storage.appendLog(
          logRecord({
            id: "s-3",
            timestamp: "2026-08-28T10:00:00.000Z",
            tool: "delete_patient",
            verdict: "deny",
            agent: { agentId: "claude-browser" },
          }),
        );
        await storage.appendLog(
          logRecord({
            id: "s-4",
            timestamp: "2026-08-28T11:00:00.000Z",
            tool: "export_patients",
            verdict: "deny",
            dataClasses: ["ssn"],
            agent: {},
          }),
        );
      });

      it("counts calls, denials, transforms and agents", async () => {
        const stats = await storage.stats();
        expect(stats.totalCalls).toBe(4);
        expect(stats.denied).toBe(2);
        expect(stats.transformed).toBe(2);
        expect(stats.uniqueAgents).toBe(2);
      });

      it("ranks tools by count, then name", async () => {
        const stats = await storage.stats();
        expect(stats.byTool).toEqual([
          { tool: "search_patients", count: 2 },
          { tool: "delete_patient", count: 1 },
          { tool: "export_patients", count: 1 },
        ]);
      });

      it("buckets by UTC day, ascending", async () => {
        const stats = await storage.stats();
        expect(stats.byDay).toEqual([
          { day: "2026-08-27", total: 1, denied: 0, transformed: 1 },
          { day: "2026-08-28", total: 3, denied: 2, transformed: 1 },
        ]);
      });

      it("honours an inclusive time range", async () => {
        const stats = await storage.stats({ since: "2026-08-28T00:00:00.000Z" });
        expect(stats.totalCalls).toBe(3);
        expect(stats.denied).toBe(2);
        expect(stats.byDay.map((day) => day.day)).toEqual(["2026-08-28"]);

        const single = await storage.stats({
          since: "2026-08-28T09:00:00.000Z",
          until: "2026-08-28T10:00:00.000Z",
        });
        expect(single.totalCalls).toBe(2);
        expect(single.byTool).toEqual([
          { tool: "delete_patient", count: 1 },
          { tool: "search_patients", count: 1 },
        ]);
      });

      it("returns zeroes for an empty range", async () => {
        const stats = await storage.stats({ since: "2027-01-01T00:00:00.000Z" });
        expect(stats).toEqual({
          totalCalls: 0,
          denied: 0,
          transformed: 0,
          uniqueAgents: 0,
          byTool: [],
          byDay: [],
        });
      });
    });

    describe("vault", () => {
      it("round-trips an entry", async () => {
        const entry = vaultEntry();
        expect(await storage.putVaultEntry(entry)).toEqual(entry);
        expect(await storage.getVaultEntry(entry.token)).toEqual(entry);
      });

      it("returns null for an unknown token", async () => {
        expect(await storage.getVaultEntry("tok_ssn_deadbeef")).toBeNull();
      });

      it("keeps the first sighting when the same token is stored again", async () => {
        const first = vaultEntry();
        await storage.putVaultEntry(first);

        const second = await storage.putVaultEntry(
          vaultEntry({ ciphertext: "bmV3", firstSeenAt: "2026-09-01T00:00:00.000Z" }),
        );

        expect(second).toEqual(first);
        expect(await storage.getVaultEntry(first.token)).toEqual(first);
      });

      it("keeps distinct tokens independent", async () => {
        await storage.putVaultEntry(vaultEntry());
        await storage.putVaultEntry(
          vaultEntry({ token: "tok_mrn_1122aabb", dataClass: "mrn", ciphertext: "b3RoZXI=" }),
        );

        expect(await storage.getVaultEntry("tok_mrn_1122aabb")).toMatchObject({
          dataClass: "mrn",
          ciphertext: "b3RoZXI=",
        });
        expect(await storage.getVaultEntry("tok_ssn_8f3a2c19")).toMatchObject({ dataClass: "ssn" });
      });
    });
  });
}
