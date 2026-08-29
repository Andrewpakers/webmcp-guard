import { RuleSchema, type GuardStorage } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

// The server package is written against the `GuardStorage` interface and
// deliberately does not depend on an adapter. Tests reach for the reference
// in-memory adapter by path rather than adding a dependency edge that would
// only ever be used by tests.
import { memoryStorage } from "../../storage-memory/src/index";

import { DEFAULT_POLICY_RULES, seedDefaultPolicy } from "./seed";

describe("DEFAULT_POLICY_RULES", () => {
  it("are the four rules docs/05 says WebMCP Guard ships with", () => {
    expect(DEFAULT_POLICY_RULES.map((rule) => rule.id)).toEqual([
      "phi-transform-default",
      "export-requires-justification",
      "destructive-requires-confirmation",
      "delete-patient-deny-temp",
    ]);
  });

  it("are all valid rules", () => {
    for (const draft of DEFAULT_POLICY_RULES) {
      expect(() => RuleSchema.parse(draft)).not.toThrow();
    }
  });

  it("ships the confirmation and justification rules disabled (judge safety)", () => {
    const enabled = Object.fromEntries(
      DEFAULT_POLICY_RULES.map((rule) => [rule.id, rule.enabled ?? true]),
    );

    expect(enabled).toEqual({
      "phi-transform-default": true,
      "export-requires-justification": false,
      "destructive-requires-confirmation": false,
      "delete-patient-deny-temp": true,
    });
  });

  it("tokenizes identifiers and contextualizes dob/address on phi-tagged tools", () => {
    const phi = DEFAULT_POLICY_RULES[0];
    expect(phi.match).toEqual({ tools: { tags: ["phi"] } });
    if (phi.action.type !== "transform") throw new Error("expected a transform rule");

    expect(phi.action.perClass).toEqual({
      ssn: "tokenize",
      mrn: "tokenize",
      name: "tokenize",
      insurance_id: "tokenize",
      dob: "contextualize",
      address: "contextualize",
      phone: "passthrough",
      // Masked, not passthrough: emails embed patient names (see seed.ts).
      email: "mask",
      credit_card: "passthrough",
      free_text_phi: "passthrough",
    });
  });

  it("tells the agent what a human should do instead of deleting", () => {
    const deny = DEFAULT_POLICY_RULES[3];
    if (deny.action.type !== "deny") throw new Error("expected a deny rule");

    expect(deny.name).toContain("TEMP (Phase 2)");
    expect(deny.action.message).toMatch(/portal/i);
    expect(deny.action.message).toMatch(/organization policy/i);
  });

  it("requires 40 characters of justification for exports", () => {
    const exportRule = DEFAULT_POLICY_RULES[1];
    expect(exportRule.match).toEqual({ tools: ["export_patients"] });
    if (exportRule.action.type !== "require-justification") throw new Error("wrong action");
    expect(exportRule.action.minChars).toBe(40);
  });
});

describe("seedDefaultPolicy", () => {
  it("writes the defaults into an empty store, in order", async () => {
    const storage = memoryStorage();
    const seeded = await seedDefaultPolicy(storage);

    expect(seeded).toHaveLength(4);
    expect((await storage.listRules()).map((rule) => rule.id)).toEqual([
      "phi-transform-default",
      "export-requires-justification",
      "destructive-requires-confirmation",
      "delete-patient-deny-temp",
    ]);
  });

  it("is idempotent: seeding twice still leaves four rules", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);
    const second = await seedDefaultPolicy(storage);

    expect(second).toEqual([]);
    expect(await storage.listRules()).toHaveLength(4);
  });

  it("leaves an existing policy alone", async () => {
    const storage = memoryStorage();
    await storage.createRule({
      id: "mine",
      name: "House rule",
      match: {},
      action: { type: "allow" },
    });

    expect(await seedDefaultPolicy(storage)).toEqual([]);
    expect((await storage.listRules()).map((rule) => rule.id)).toEqual(["mine"]);
  });

  it("does not resurrect a default rule an administrator deleted", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);
    await storage.deleteRule("delete-patient-deny-temp");
    await seedDefaultPolicy(storage);

    expect(await storage.getRule("delete-patient-deny-temp")).toBeNull();
    expect(await storage.listRules()).toHaveLength(3);
  });

  it("survives two processes racing to seed the same database", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);

    // The loser of the race still sees an empty list when it checks, then hits
    // duplicate-rule on every insert.
    const racing: GuardStorage = { ...storage, listRules: async () => [] };

    await expect(seedDefaultPolicy(racing)).resolves.toEqual([]);
    expect(await storage.listRules()).toHaveLength(4);
  });
});
