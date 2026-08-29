import { describe, expect, it } from "vitest";

import {
  TOKEN_STORAGE_KEY,
  clearStoredToken,
  maskToken,
  readStoredToken,
  storeToken,
  type TokenStore,
} from "./session";

function fakeStore(initial: Record<string, string> = {}): TokenStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("token session storage", () => {
  it("round-trips a token", () => {
    const store = fakeStore();
    storeToken(store, "dev-only-admin-token--do-not-deploy");
    expect(store.data[TOKEN_STORAGE_KEY]).toBe("dev-only-admin-token--do-not-deploy");
    expect(readStoredToken(store)).toBe("dev-only-admin-token--do-not-deploy");
  });

  it("trims and treats blank as absent", () => {
    const store = fakeStore({ [TOKEN_STORAGE_KEY]: "   " });
    expect(readStoredToken(store)).toBeNull();
    storeToken(store, "  padded  ");
    expect(readStoredToken(store)).toBe("padded");
  });

  it("clears on disconnect", () => {
    const store = fakeStore({ [TOKEN_STORAGE_KEY]: "t" });
    clearStoredToken(store);
    expect(readStoredToken(store)).toBeNull();
  });

  it("is a no-op without a store (SSR, blocked storage)", () => {
    expect(readStoredToken(null)).toBeNull();
    expect(() => storeToken(null, "t")).not.toThrow();
    expect(() => clearStoredToken(null)).not.toThrow();
  });

  it("survives a storage that throws", () => {
    const hostile: TokenStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredToken(hostile)).toBeNull();
    expect(() => storeToken(hostile, "t")).not.toThrow();
    expect(() => clearStoredToken(hostile)).not.toThrow();
  });
});

describe("maskToken", () => {
  it("shows only the ends of a long token", () => {
    expect(maskToken("dev-only-admin-token--do-not-deploy")).toBe("dev-…loy");
  });

  it("shows nothing at all of a short one", () => {
    expect(maskToken("shortie")).toBe("•••••••");
  });
});
