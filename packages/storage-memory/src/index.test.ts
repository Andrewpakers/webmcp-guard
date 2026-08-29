import { runGuardStorageContract } from "@webmcp-guard/shared/storage-contract";
import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, memoryStorage } from "./index";

describe("@webmcp-guard/storage-memory", () => {
  it("is wired into the workspace test run", () => {
    expect(PACKAGE_NAME).toBe("@webmcp-guard/storage-memory");
  });

  it("derives readable ids from the rule name and de-duplicates them", async () => {
    const storage = memoryStorage();
    await storage.init();

    const first = await storage.createRule({
      name: "Export requires justification",
      match: {},
      action: { type: "allow" },
    });
    const second = await storage.createRule({
      name: "Export requires justification",
      match: {},
      action: { type: "allow" },
    });

    expect(first.id).toBe("export-requires-justification");
    expect(second.id).toBe("export-requires-justification-2");
  });

  it("resets to an empty store", async () => {
    const storage = memoryStorage();
    await storage.init();
    await storage.createRule({ name: "Rule", match: {}, action: { type: "allow" } });
    await storage.setDefaultAction("deny");

    storage.reset();

    expect(await storage.listRules()).toEqual([]);
    expect(await storage.getDefaultAction()).toBe("allow");
  });

  it("isolates instances from one another", async () => {
    const a = memoryStorage();
    const b = memoryStorage();
    await a.createRule({ name: "Only in A", match: {}, action: { type: "allow" } });

    expect(await a.listRules()).toHaveLength(1);
    expect(await b.listRules()).toHaveLength(0);
  });
});

runGuardStorageContract("storage-memory", () => memoryStorage());
