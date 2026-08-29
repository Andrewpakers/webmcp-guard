import { describe, expect, it } from "vitest";

import { escapeCsvValue, toCsv, toCsvRow } from "./csv";

describe("escapeCsvValue", () => {
  it("leaves plain values untouched", () => {
    expect(escapeCsvValue("Hypertension")).toBe("Hypertension");
    expect(escapeCsvValue("LM-100001")).toBe("LM-100001");
  });

  it("quotes values containing a comma", () => {
    expect(escapeCsvValue("12 Elm St, Portland, OR")).toBe('"12 Elm St, Portland, OR"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvValue('She said "no known allergies"')).toBe(
      '"She said ""no known allergies"""',
    );
  });

  it("quotes values containing newlines", () => {
    expect(escapeCsvValue("line one\nline two")).toBe('"line one\nline two"');
    expect(escapeCsvValue("line one\r\nline two")).toBe('"line one\r\nline two"');
  });

  it("quotes values with significant leading/trailing whitespace", () => {
    expect(escapeCsvValue("  padded  ")).toBe('"  padded  "');
  });

  it("renders null and undefined as empty fields", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });

  it("stringifies non-strings", () => {
    expect(escapeCsvValue(42)).toBe("42");
    expect(escapeCsvValue(false)).toBe("false");
  });
});

describe("toCsvRow / toCsv", () => {
  it("joins fields with commas", () => {
    expect(toCsvRow(["a", "b", "c"])).toBe("a,b,c");
  });

  it("emits a CRLF-terminated document with a header", () => {
    const csv = toCsv(["mrn", "name"], [["LM-100001", "Ada Byron"]]);
    expect(csv).toBe("mrn,name\r\nLM-100001,Ada Byron\r\n");
  });

  it("keeps a quoted, comma-bearing field in a single column", () => {
    const csv = toCsv(["mrn", "address"], [["LM-100002", "12 Elm St, Portland, OR"]]);
    expect(csv).toBe('mrn,address\r\nLM-100002,"12 Elm St, Portland, OR"\r\n');
  });

  it("still emits the header for an empty result set", () => {
    expect(toCsv(["mrn"], [])).toBe("mrn\r\n");
  });
});
