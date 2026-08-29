#!/usr/bin/env node
/**
 * Headless WebMCP end-to-end harness.
 *
 * Launches Chromium with WebMCP enabled, loads a page, waits for tools to
 * register on document.modelContext, and can list tools, execute a tool, or
 * capture a screenshot. Used for local verification only — judges use
 * ChatGPT's in-app browser or Chrome with the WebMCP flag.
 *
 * Usage:
 *   node scripts/webmcp-e2e.mjs --url http://localhost:3000/patients list
 *   node scripts/webmcp-e2e.mjs --url http://localhost:3000 call search_patients '{"query":"hypertension"}'
 *   node scripts/webmcp-e2e.mjs --url http://localhost:3000/patients shot out.png
 *   node scripts/webmcp-e2e.mjs --url http://localhost:3000 eval 'document.title'
 *   node scripts/webmcp-e2e.mjs --url http://localhost:3000 confirm delete_patient '{"patient":"LM-100060"}' decline
 *
 * `confirm` is `call` plus a human: it starts the tool call, waits for WebMCP
 * Guard's approval modal to appear in the page, clicks Approve or Decline
 * through its data-testid, and then prints whatever the agent got back. That is
 * the Phase 5 confirmation flow driven end to end, with the real modal.
 *
 * Requires: snap chromium >= 149 (this machine: 151). Note snap confinement —
 * chromium cannot read /tmp, so screenshots are written by this script, not
 * the browser, and pages must be served over http.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const url = flag("--url", "http://localhost:3000");
const timeoutMs = Number(flag("--timeout", "30000"));
const minTools = Number(flag("--min-tools", "1"));
const cmdIdx = args.findIndex((a) => ["list", "call", "shot", "eval", "confirm"].includes(a));
const command = cmdIdx >= 0 ? args[cmdIdx] : "list";
const cmdArgs = cmdIdx >= 0 ? args.slice(cmdIdx + 1) : [];

const chromium = flag("--browser", "chromium");
const port = 9000 + Math.floor(Math.random() * 800);
// Snap chromium can only write to non-hidden paths under $HOME (dotfiles are
// excluded by snap confinement); its own common dir is the safest choice.
const profileBase = path.join(os.homedir(), "snap", "chromium", "common");
mkdirSync(profileBase, { recursive: true });
const profile = mkdtempSync(path.join(profileBase, "webmcp-e2e-"));

const child = spawn(
  chromium,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-first-run",
    "--enable-features=WebMCP",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup(code = 0) {
  try {
    child.kill("SIGKILL");
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => cleanup(130));

async function fetchJson(u, opts) {
  const res = await fetch(u, opts);
  if (!res.ok) throw new Error(`${u} -> ${res.status}`);
  return res.json();
}

async function waitForCdp() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
      await sleep(200);
    }
  }
  throw new Error("CDP endpoint never came up");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return new Cdp(ws);
}

async function evalInPage(cdp, expression) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails),
    );
  }
  return r.result.value;
}

try {
  await waitForCdp();
  // Create a page target and connect to it.
  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // Wait for load + tool registration.
  const deadline = Date.now() + timeoutMs;
  let tools = [];
  while (Date.now() < deadline) {
    try {
      tools = await evalInPage(
        cdp,
        `(async () => {
           const mc = document.modelContext ?? navigator.modelContext;
           if (!mc?.getTools) return [];
           const ts = await mc.getTools();
           return ts.map(t => ({ name: t.name, description: (t.description||"").slice(0,80), annotations: t.annotations }));
         })()`,
      );
      if (tools.length >= minTools) break;
    } catch {}
    await sleep(400);
  }

  if (command === "list") {
    console.log(JSON.stringify({ url, toolCount: tools.length, tools }, null, 2));
    if (tools.length < minTools) {
      console.error(`FAIL: expected >= ${minTools} tools`);
      cleanup(1);
    }
  } else if (command === "call") {
    const [toolName, jsonInput = "{}"] = cmdArgs;
    const result = await evalInPage(
      cdp,
      `(async () => {
         const mc = document.modelContext ?? navigator.modelContext;
         const ts = await mc.getTools();
         const tool = ts.find(t => t.name === ${JSON.stringify(toolName)});
         if (!tool) throw new Error("tool not registered: " + ${JSON.stringify(toolName)});
         const r = await mc.executeTool(tool, ${JSON.stringify(jsonInput)});
         return r;
       })()`,
    );
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } else if (command === "confirm") {
    const [toolName, jsonInput = "{}", choice = "decline"] = cmdArgs;
    const testId =
      choice === "approve"
        ? "webmcp-guard-confirmation-approve"
        : "webmcp-guard-confirmation-decline";

    // Start the call without awaiting it: the guarded execute is blocked on the
    // modal, which does not exist yet.
    await evalInPage(
      cdp,
      `(async () => {
         const mc = document.modelContext ?? navigator.modelContext;
         const ts = await mc.getTools();
         const tool = ts.find(t => t.name === ${JSON.stringify(toolName)});
         if (!tool) throw new Error("tool not registered: " + ${JSON.stringify(toolName)});
         window.__webmcpGuardCall = mc.executeTool(tool, ${JSON.stringify(jsonInput)});
         return "started";
       })()`,
    );

    // Wait for the real modal to be in the page…
    const shown = await evalInPage(
      cdp,
      `(async () => {
         for (let i = 0; i < 60; i++) {
           const dialog = document.querySelector('[data-testid="webmcp-guard-confirmation"]');
           if (dialog) {
             return {
               tool: document.querySelector('[data-testid="webmcp-guard-confirmation-tool"]')?.textContent,
               message: document.querySelector('[data-testid="webmcp-guard-confirmation-message"]')?.textContent,
               args: document.querySelector('[data-testid="webmcp-guard-confirmation-args"]')?.textContent,
               visible: true,
             };
           }
           await new Promise(r => setTimeout(r, 250));
         }
         return null;
       })()`,
    );

    // …optionally photograph it, then click the way a person would.
    const clicked = shown;
    if (clicked && args.includes("--shot")) {
      await sleep(400);
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      clicked.screenshot = shot.data;
    }
    if (clicked) {
      await evalInPage(
        cdp,
        `document.querySelector('[data-testid="${testId}"]').click(), "clicked"`,
      );
    }

    if (!clicked) {
      console.error("FAIL: the confirmation modal never appeared");
      cleanup(1);
    }
    console.error(`[modal] ${JSON.stringify(clicked)}`);
    if (clicked.screenshot) {
      writeFileSync(flag("--shot", "modal.png"), Buffer.from(clicked.screenshot, "base64"));
    }

    const result = await evalInPage(cdp, "window.__webmcpGuardCall");
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } else if (command === "shot") {
    const [outfile = "screenshot.png"] = cmdArgs;
    await sleep(1200); // let fonts/paint settle
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(outfile, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${outfile} (${tools.length} tools registered)`);
  } else if (command === "eval") {
    const [expression] = cmdArgs;
    const result = await evalInPage(cdp, expression);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }
  cleanup(0);
} catch (err) {
  console.error(String(err));
  cleanup(1);
}
