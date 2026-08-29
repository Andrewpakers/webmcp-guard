import { describe, expect, it, vi } from "vitest";

import { collectGuardTokens, detokenize, substituteTokens } from "./detokenize";
import { createTokenizer } from "./tokenize";

/**
 * Inbound detokenization: tokens the agent kept from a previous turn become
 * real values again, and anything the vault does not know is left exactly as it
 * arrived (`docs/04`: "unknown tokens pass through untouched").
 */

const tokenizer = createTokenizer({ orgSecret: "org-secret", vaultKey: "vault-key" });

const MRN_TOKEN = tokenizer.tokenFor("LM-100001", "mrn");
const NAME_TOKEN = tokenizer.tokenFor("Tricia Bashirian", "name");

const VAULT = new Map<string, string>([
  [MRN_TOKEN, "LM-100001"],
  [NAME_TOKEN, "Tricia Bashirian"],
]);

const resolve = (token: string) => VAULT.get(token) ?? null;

describe("collectGuardTokens", () => {
  it("finds tokens anywhere in a nested value, once each", () => {
    expect(
      collectGuardTokens({
        patient: MRN_TOKEN,
        note: `Spoke to ${NAME_TOKEN} about ${MRN_TOKEN}.`,
        list: [{ deep: NAME_TOKEN }],
      }),
    ).toEqual([MRN_TOKEN, NAME_TOKEN]);
  });

  it("ignores token-shaped strings that are not tokens", () => {
    expect(
      collectGuardTokens([
        "tok_name_1a2b3c4",
        "tok_name_1a2b3c4dd",
        "tok_nome_1a2b3c4d",
        "tok_name_1A2B3C4D",
        "xtok_name_1a2b3c4d",
        "tok_name_1a2b3c4dz",
      ]),
    ).toEqual([]);
  });

  it("does not look at object keys", () => {
    expect(collectGuardTokens({ [MRN_TOKEN]: "value" })).toEqual([]);
  });
});

describe("substituteTokens", () => {
  it("rebuilds the value without mutating the original", () => {
    const args = { patient: MRN_TOKEN, nested: { note: `Call ${NAME_TOKEN}.` } };
    const output = substituteTokens(args, VAULT) as typeof args;

    expect(output).toEqual({
      patient: "LM-100001",
      nested: { note: "Call Tricia Bashirian." },
    });
    expect(args.patient).toBe(MRN_TOKEN);
    expect(output.nested).not.toBe(args.nested);
  });

  it("returns the input untouched when there is nothing to substitute", () => {
    const args = { patient: MRN_TOKEN };
    expect(substituteTokens(args, new Map())).toBe(args);
  });
});

describe("detokenize", () => {
  it("round-trips a token minted by the tokenizer", async () => {
    const sealed = tokenizer.seal("LM-100042", "mrn");
    const vault = new Map([[sealed.token, sealed.entry]]);

    const result = await detokenize({ patient: sealed.token }, (token) => {
      const entry = vault.get(token);
      return entry ? tokenizer.open(entry) : null;
    });

    expect(result.value).toEqual({ patient: "LM-100042" });
    expect(result.replaced).toEqual([sealed.token]);
    expect(result.unresolved).toEqual([]);
  });

  it("leaves an unknown token exactly as it arrived", async () => {
    const unknown = "tok_ssn_deadbeef";
    const result = await detokenize({ patient: MRN_TOKEN, other: unknown }, resolve);

    expect(result.value).toEqual({ patient: "LM-100001", other: unknown });
    expect(result.replaced).toEqual([MRN_TOKEN]);
    expect(result.unresolved).toEqual([unknown]);
  });

  it("substitutes tokens embedded in free text", async () => {
    const result = await detokenize(
      { note: `Called ${NAME_TOKEN} about chart ${MRN_TOKEN}; also tok_ssn_deadbeef.` },
      resolve,
    );

    expect(result.value).toEqual({
      note: "Called Tricia Bashirian about chart LM-100001; also tok_ssn_deadbeef.",
    });
  });

  it("resolves each distinct token exactly once, however often it appears", async () => {
    const spy = vi.fn(resolve);
    await detokenize({ a: MRN_TOKEN, b: MRN_TOKEN, c: `${MRN_TOKEN} ${MRN_TOKEN}` }, spy);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("passes the parsed class to the resolver", async () => {
    const spy = vi.fn(resolve);
    await detokenize({ patient: MRN_TOKEN }, spy);
    expect(spy).toHaveBeenCalledWith(MRN_TOKEN, "mrn");
  });

  it("short-circuits a value with no tokens at all", async () => {
    const args = { text: "hypertension" };
    const spy = vi.fn(resolve);

    const result = await detokenize(args, spy);
    expect(result.value).toBe(args);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not re-scan a substituted value for further tokens", async () => {
    // A vault value that itself looks like a token must not chain.
    const chained = new Map([[MRN_TOKEN, `see ${NAME_TOKEN}`]]);
    const result = await detokenize({ patient: MRN_TOKEN }, (token) => chained.get(token) ?? null);

    expect(result.value).toEqual({ patient: `see ${NAME_TOKEN}` });
  });
});
