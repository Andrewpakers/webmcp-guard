import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GUARD_DEV_DEFAULTS,
  getGuardServer,
  insecureDefaultsWarning,
  resetGuardServer,
  resetGuardServerWarning,
  resolveGuardSecrets,
} from "./server";

const SECRET_VARS = [
  "GUARD_ORG_SECRET",
  "GUARD_VAULT_KEY",
  "GUARD_ADMIN_TOKEN",
  "GUARD_CONSOLE_ORIGIN",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of SECRET_VARS) {
    saved.set(name, process.env[name]);
    delete process.env[name];
  }
  resetGuardServer();
  resetGuardServerWarning();
});

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
  resetGuardServer();
  vi.restoreAllMocks();
});

describe("resolveGuardSecrets", () => {
  it("uses the environment when it is configured", () => {
    const secrets = resolveGuardSecrets({
      GUARD_ORG_SECRET: "org",
      GUARD_VAULT_KEY: "vault",
      GUARD_ADMIN_TOKEN: "admin",
      GUARD_CONSOLE_ORIGIN: "https://console.example",
    });

    expect(secrets).toEqual({
      orgSecret: "org",
      vaultKey: "vault",
      adminToken: "admin",
      consoleOrigin: "https://console.example",
      fellBack: [],
    });
  });

  it("falls back to obviously-insecure defaults so a clean clone boots", () => {
    const secrets = resolveGuardSecrets({});

    expect(secrets.orgSecret).toBe(GUARD_DEV_DEFAULTS.GUARD_ORG_SECRET);
    expect(secrets.vaultKey).toBe(GUARD_DEV_DEFAULTS.GUARD_VAULT_KEY);
    expect(secrets.adminToken).toBe(GUARD_DEV_DEFAULTS.GUARD_ADMIN_TOKEN);
    expect(secrets.fellBack).toEqual(["GUARD_ORG_SECRET", "GUARD_VAULT_KEY", "GUARD_ADMIN_TOKEN"]);
    // Nobody can mistake these for real secrets, which is the point.
    for (const value of Object.values(GUARD_DEV_DEFAULTS)) {
      expect(value).toContain("dev-only");
      expect(value).toContain("do-not-deploy");
    }
  });

  it("treats a blank or whitespace value as missing", () => {
    const secrets = resolveGuardSecrets({
      GUARD_ORG_SECRET: "",
      GUARD_VAULT_KEY: "   ",
      GUARD_ADMIN_TOKEN: "admin",
      GUARD_CONSOLE_ORIGIN: "  ",
    });

    expect(secrets.fellBack).toEqual(["GUARD_ORG_SECRET", "GUARD_VAULT_KEY"]);
    expect(secrets.adminToken).toBe("admin");
    // No console origin means same-origin only — never a wildcard.
    expect(secrets.consoleOrigin).toBeUndefined();
  });

  it("names every variable that fell back in the warning", () => {
    const warning = insecureDefaultsWarning(["GUARD_ORG_SECRET", "GUARD_ADMIN_TOKEN"]);

    expect(warning).toContain("GUARD_ORG_SECRET");
    expect(warning).toContain("GUARD_ADMIN_TOKEN");
    expect(warning).toContain(".env.example");
  });
});

describe("getGuardServer", () => {
  it("memoises one server for the process", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getGuardServer()).toBe(getGuardServer());
  });

  it("warns once about the insecure defaults, not once per rebuild", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    getGuardServer();
    resetGuardServer();
    getGuardServer();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("insecure development defaults");
  });

  it("stays quiet when the environment is configured", () => {
    process.env.GUARD_ORG_SECRET = "org";
    process.env.GUARD_VAULT_KEY = "vault";
    process.env.GUARD_ADMIN_TOKEN = "admin";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    getGuardServer();
    expect(warn).not.toHaveBeenCalled();
  });
});
