# WebMCP Guard

WebMCP Guard is a drop-in SDK that wraps a website's WebMCP tools with enterprise
security controls — policy-based authorization, agent/browser posture checks, and
sensitive-data tokenization — managed from a web console, so organizations can open
their internal apps to AI agents without opening their data.

> **Under construction.** This repository is an entry for the Devpost WebMCP
> Challenge and is mid-build. Phase 0 (scaffold) is in place; the SDK, policy
> engine, demo portal, and console land in subsequent phases. See
> [`docs/07-development-plan.md`](docs/07-development-plan.md) for the plan and
> current status.

## Repository layout

```
packages/
  shared/           @webmcp-guard/shared          types, zod policy/wire/log schemas
  sdk/              @webmcp-guard/sdk             browser-side registerTool wrapper
  server/           @webmcp-guard/server          policy engine, classifiers, vault, routes
  storage-memory/   @webmcp-guard/storage-memory  in-memory GuardStorage (tests/demos)
  storage-sqlite/   @webmcp-guard/storage-sqlite  better-sqlite3 GuardStorage
apps/
  portal/           Lakeside Medical demo app (port 3000)
  console/          WebMCP Guard management console (port 3001)
```

## Quickstart

_Placeholder — the verified-from-a-clean-clone quickstart lands in Phase 7._

```bash
pnpm install
cp .env.example .env.local   # fill in the secrets
pnpm dev                     # portal on :3000, console on :3001
```

Workspace scripts:

| Command          | What it does                                     |
| ---------------- | ------------------------------------------------ |
| `pnpm dev`       | Runs the portal (:3000) and console (:3001)      |
| `pnpm test`      | Vitest across every package and app, in one pass |
| `pnpm typecheck` | `tsc --noEmit` per workspace package             |
| `pnpm lint`      | ESLint (flat config) across the workspace        |
| `pnpm format`    | Prettier write                                   |

## Documentation

The design pack lives in [`docs/`](docs/): project brief, challenge
requirements, architecture and threat model, SDK requirements, demo app and
console requirements, the development plan, and a WebMCP API reference.

## License

MIT — see [`LICENSE`](LICENSE).
