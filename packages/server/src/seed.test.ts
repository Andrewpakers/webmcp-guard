import { RuleSchema, type GuardStorage } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

// The server package is written against the `GuardStorage` interface and
// deliberately does not depend on an adapter. Tests reach for the reference
// in-memory adapter by path rather than adding a dependency edge that would
// only ever be used by tests.
import { memoryStorage } from "../../storage-memory/src/index";

import { resolvePolicy } from "./policy-engine";
import { DEFAULT_POLICY_RULES, seedDefaultPolicy } from "./seed";

const SEEDED_IDS = [
  "posture-deny-unknown-agent",
  "posture-deny-old-browser",
  "phi-transform-default",
  "export-requires-justification",
  "destructive-requires-confirmation",
];

function ruleById(id: string) {
  const rule = DEFAULT_POLICY_RULES.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(`no seeded rule ${id}`);
  return rule;
}

describe("DEFAULT_POLICY_RULES", () => {
  it("are the rules docs/05 says WebMCP Guard ships with", () => {
    expect(DEFAULT_POLICY_RULES.map((rule) => rule.id)).toEqual(SEEDED_IDS);
  });

  it("are all valid rules", () => {
    for (const draft of DEFAULT_POLICY_RULES) {
      expect(() => RuleSchema.parse(draft)).not.toThrow();
    }
  });

  it("ships the posture pack disabled and everything else enabled (judge safety)", () => {
    const enabled = Object.fromEntries(
      DEFAULT_POLICY_RULES.map((rule) => [rule.id, rule.enabled ?? true]),
    );

    expect(enabled).toEqual({
      "posture-deny-unknown-agent": false,
      "posture-deny-old-browser": false,
      "phi-transform-default": true,
      "export-requires-justification": true,
      "destructive-requires-confirmation": true,
    });
  });

  it("names the posture rules so the console's toggle finds them", () => {
    // apps/console/lib/policy/rule-form.ts → isPostureRule matches on "posture"
    // appearing in the id or the name.
    const posture = DEFAULT_POLICY_RULES.filter((rule) =>
      `${rule.id} ${rule.name}`.toLowerCase().includes("posture"),
    );
    expect(posture.map((rule) => rule.id)).toEqual([
      "posture-deny-unknown-agent",
      "posture-deny-old-browser",
    ]);
  });

  it("runs posture ahead of every other gate rule", () => {
    const priorities = DEFAULT_POLICY_RULES.map((rule) => rule.priority ?? 0);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(ruleById("posture-deny-unknown-agent").priority).toBeLessThan(
      ruleById("phi-transform-default").priority ?? 0,
    );
  });

  it("tokenizes identifiers and contextualizes dob/address on phi-tagged tools", () => {
    const phi = ruleById("phi-transform-default");
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

  it("requires 40 characters of justification for exports", () => {
    const exportRule = ruleById("export-requires-justification");
    expect(exportRule.match).toEqual({ tools: ["export_patients"] });
    if (exportRule.action.type !== "require-justification") throw new Error("wrong action");
    expect(exportRule.action.minChars).toBe(40);
  });

  it("covers every destructive tool with the confirmation rule", () => {
    const rule = ruleById("destructive-requires-confirmation");
    expect(rule.match).toEqual({ tools: { tags: ["destructive"] } });
    if (rule.action.type !== "require-confirmation") throw new Error("wrong action");
    expect(rule.action.message).toMatch(/approved by the person using this page/i);
  });

  it("no longer ships the Phase 2 blanket deny on delete_patient", () => {
    expect(DEFAULT_POLICY_RULES.map((rule) => rule.id)).not.toContain("delete-patient-deny-temp");
  });

  it("tells the agent what to do instead, in every deny message", () => {
    for (const rule of DEFAULT_POLICY_RULES) {
      if (rule.action.type !== "deny") continue;
      expect(rule.action.message.length).toBeGreaterThan(60);
      expect(rule.action.message).toMatch(/ask the person using this page/i);
    }
  });

  it("only denies on posture once a snapshot actually arrives", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);
    for (const id of ["posture-deny-unknown-agent", "posture-deny-old-browser"]) {
      await storage.updateRule(id, { enabled: true });
    }
    const policy = await storage.getPolicy();

    const call = { app: "lakeside-portal", tool: "search_patients", toolTags: ["read", "phi"] };
    expect(resolvePolicy(policy, call).verdict).toBe("allow");

    const denied = resolvePolicy(policy, {
      ...call,
      posture: { isSecureContext: true, timestamp: "2026-08-29T12:00:00.000Z" },
    });
    expect(denied.verdict).toBe("deny");
    expect(denied.gateRule?.id).toBe("posture-deny-unknown-agent");
  });

  it("denies a pre-WebMCP Chromium through the old-browser rule", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);
    await storage.updateRule("posture-deny-old-browser", { enabled: true });

    const decision = resolvePolicy(await storage.getPolicy(), {
      app: "lakeside-portal",
      tool: "search_patients",
      toolTags: ["read", "phi"],
      posture: {
        isSecureContext: true,
        timestamp: "2026-08-29T12:00:00.000Z",
        // Identified agent, so only the browser-version rule can fire.
        agentId: "chatgpt-atlas",
        brands: [
          { brand: "Chromium", version: "142" },
          { brand: "Google Chrome", version: "142" },
        ],
      },
    });

    expect(decision.verdict).toBe("deny");
    expect(decision.gateRule?.id).toBe("posture-deny-old-browser");
  });
});

describe("seedDefaultPolicy", () => {
  it("writes the defaults into an empty store, in order", async () => {
    const storage = memoryStorage();
    const seeded = await seedDefaultPolicy(storage);

    expect(seeded).toHaveLength(SEEDED_IDS.length);
    expect((await storage.listRules()).map((rule) => rule.id)).toEqual(SEEDED_IDS);
  });

  it("is idempotent: seeding twice still leaves one copy of each rule", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);
    const second = await seedDefaultPolicy(storage);

    expect(second).toEqual([]);
    expect(await storage.listRules()).toHaveLength(SEEDED_IDS.length);
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
    await storage.deleteRule("destructive-requires-confirmation");
    await seedDefaultPolicy(storage);

    expect(await storage.getRule("destructive-requires-confirmation")).toBeNull();
    expect(await storage.listRules()).toHaveLength(SEEDED_IDS.length - 1);
  });

  it("survives two processes racing to seed the same database", async () => {
    const storage = memoryStorage();
    await seedDefaultPolicy(storage);

    // The loser of the race still sees an empty list when it checks, then hits
    // duplicate-rule on every insert.
    const racing: GuardStorage = { ...storage, listRules: async () => [] };

    await expect(seedDefaultPolicy(racing)).resolves.toEqual([]);
    expect(await storage.listRules()).toHaveLength(SEEDED_IDS.length);
  });
});
