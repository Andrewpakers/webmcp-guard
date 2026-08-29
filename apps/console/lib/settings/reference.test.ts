import { DATA_CLASSES, TRANSFORM_ACTIONS } from "@webmcp-guard/shared";
import { describe, expect, it } from "vitest";

import {
  DATA_CLASS_REFERENCE,
  TOKEN_FORMAT,
  TRANSFORM_ACTION_HINT,
  referencedDataClasses,
} from "./reference";

describe("settings reference copy", () => {
  it("documents every data class, in the shared enum's order", () => {
    expect(referencedDataClasses()).toEqual([...DATA_CLASSES]);
  });

  it("gives every class a label, a description and an example", () => {
    for (const entry of DATA_CLASS_REFERENCE) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.example.length).toBeGreaterThan(0);
    }
  });

  it("explains every transform action the matrix offers", () => {
    for (const action of TRANSFORM_ACTIONS) {
      expect(TRANSFORM_ACTION_HINT[action]).toBeTruthy();
    }
  });

  it("shows a token example that matches the documented format", () => {
    expect(TOKEN_FORMAT.pattern).toBe("tok_<class>_<hex8>");
    expect(TOKEN_FORMAT.example).toMatch(/^tok_[a-z_]+_[0-9a-f]{8}$/);
  });
});
