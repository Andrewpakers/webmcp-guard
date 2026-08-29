import { describe, expect, it } from "vitest";

import {
  DEFAULT_JUSTIFICATION_MIN_CHARS,
  JUSTIFICATION_ARG,
  MAX_JUSTIFICATION_CHARS,
  heuristicJustificationEvaluator,
  isKeyboardMash,
  isSingleRepeatedCharacter,
  stripJustification,
  type JustificationEvaluationInput,
} from "./justification";

/**
 * The heuristic checks **effort, not truth** — see the module header. These
 * tests are written to that claim: a real sentence passes, filler fails, and
 * nothing here pretends to know whether an export is genuinely warranted.
 */

const GOOD =
  "Dr. Reyes asked for the hypertension cohort to prepare Monday's care-gap review meeting.";

function input(
  justification: string,
  overrides: Partial<JustificationEvaluationInput["context"]> = {},
): JustificationEvaluationInput {
  return {
    tool: "export_patients",
    args: { condition: "hypertension" },
    justification,
    context: { app: "lakeside-portal", minChars: DEFAULT_JUSTIFICATION_MIN_CHARS, ...overrides },
  };
}

const evaluate = (text: string, overrides?: Partial<JustificationEvaluationInput["context"]>) =>
  heuristicJustificationEvaluator.evaluate(input(text, overrides));

describe("heuristicJustificationEvaluator", () => {
  it("passes a specific, human sentence", () => {
    const result = evaluate(GOOD);
    expect(result.verdict).toBe("pass");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("passes anything over the bar that is not filler", () => {
    expect(
      evaluate(
        "Compliance audit 2026-Q3 requested by Sam Levin in billing; " +
          "the file goes to the auditor's secure drop.",
      ).verdict,
    ).toBe("pass");
  });

  it("fails on length, and says how short it was", () => {
    const result = evaluate("Need the data.");
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("14 characters");
    expect(result.reason).toContain("40");
  });

  it("counts trimmed length, so padding with whitespace does not help", () => {
    expect(evaluate(`   ${" ".repeat(80)}audit   `).verdict).toBe("fail");
  });

  it("honours a rule's own minimum", () => {
    expect(evaluate("Care-gap review for Dr. Reyes.", { minChars: 10 }).verdict).toBe("pass");
    expect(evaluate(GOOD, { minChars: 500 }).verdict).toBe("fail");
  });

  it("fails one character repeated, however long", () => {
    const result = evaluate("a".repeat(80));
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("one character repeated");
  });

  it("fails keyboard mashing that is long enough to clear the bar", () => {
    const result = evaluate("asdfasdfasdfasdfasdfasdfasdfasdfasdfasdfasdf");
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("keyboard filler");
    expect(evaluate("qwertyuiopqwertyuiopqwertyuiopqwertyuiopqwerty").verdict).toBe("fail");
  });

  it("fails a stock phrase even when the minimum is lowered", () => {
    const result = evaluate("Because I need it", { minChars: 5 });
    expect(result.verdict).toBe("fail");
    expect(result.reason).toContain("stock phrase");

    // Normalised before matching: case and punctuation do not rescue it.
    expect(evaluate("because i need it!!!", { minChars: 5 }).verdict).toBe("fail");
    expect(evaluate("N/A", { minChars: 2 }).verdict).toBe("fail");
    expect(evaluate("test", { minChars: 2 }).verdict).toBe("fail");
  });

  it("does not flag real prose that happens to contain a stock phrase", () => {
    expect(
      evaluate("The auditor said 'because I need it' is not enough, so: Q3 HIPAA review.").verdict,
    ).toBe("pass");
  });
});

describe("isSingleRepeatedCharacter", () => {
  it("ignores whitespace between the repeats", () => {
    expect(isSingleRepeatedCharacter("aaaa")).toBe(true);
    expect(isSingleRepeatedCharacter("a a a a")).toBe(true);
    expect(isSingleRepeatedCharacter("....")).toBe(true);
    expect(isSingleRepeatedCharacter("ab")).toBe(false);
    expect(isSingleRepeatedCharacter("")).toBe(false);
  });
});

describe("isKeyboardMash", () => {
  it("catches runs along a keyboard row, including repeats", () => {
    expect(isKeyboardMash("asdf")).toBe(true);
    expect(isKeyboardMash("asdfasdf")).toBe(true);
    expect(isKeyboardMash("qwerty")).toBe(true);
    expect(isKeyboardMash("1234567890")).toBe(true);
  });

  it("leaves short strings and real words alone", () => {
    expect(isKeyboardMash("asd")).toBe(false);
    expect(isKeyboardMash(GOOD)).toBe(false);
    expect(isKeyboardMash("Quarterly compliance audit for the billing team")).toBe(false);
  });
});

describe("stripJustification", () => {
  it("removes the guard's own argument and hands back the rest", () => {
    const args = { condition: "hypertension", [JUSTIFICATION_ARG]: GOOD };
    const result = stripJustification(args);

    expect(result.args).toEqual({ condition: "hypertension" });
    expect(result.justification).toBe(GOOD);
    // The caller's object is untouched: the audit log stores what arrived.
    expect(args[JUSTIFICATION_ARG]).toBe(GOOD);
  });

  it("leaves arguments alone when there is no justification to strip", () => {
    const args = { condition: "hypertension" };
    const result = stripJustification(args);

    expect(result.args).toBe(args);
    expect(result.justification).toBeNull();
  });

  it("ignores a non-string justification rather than coercing it", () => {
    expect(stripJustification({ justification: 42 }).justification).toBeNull();
    expect(stripJustification({ justification: { text: "x" } }).justification).toBeNull();
  });

  it("caps a hostile justification instead of storing megabytes of it", () => {
    const long = stripJustification({ justification: "x".repeat(MAX_JUSTIFICATION_CHARS * 3) });
    expect(long.justification).toHaveLength(MAX_JUSTIFICATION_CHARS);
  });
});
