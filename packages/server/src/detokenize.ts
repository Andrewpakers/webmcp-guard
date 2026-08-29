import { guardTokenPattern, parseGuardToken, type DataClass } from "@webmcp-guard/shared";

/**
 * Inbound detokenization — step 4 of the pipeline in `docs/03-architecture.md`.
 *
 * An agent that was handed `tok_mrn_99aa00bb` last turn can pass it straight
 * back into any tool that takes a patient identifier. `/gate` swaps the tokens
 * in the arguments for the real values *after* it has decided to allow the
 * call, and the site's own `execute` then runs against real data with the human
 * watching in the page.
 *
 * The rules, from `docs/04-sdk-requirements.md`:
 *
 * - only tokens that exist in the vault are substituted;
 * - **unknown tokens pass through untouched** — an agent that invents a
 *   token-shaped string gets it back verbatim and the tool decides what to do
 *   with it, which is far better than an error the model cannot act on;
 * - substitution happens server-side only. The browser SDK never holds the map.
 *
 * Substitution is a single pass: a value pulled out of the vault is *not*
 * re-scanned for tokens. Vault values are the host app's own data, and
 * re-scanning would let one crafted record chain into another.
 */

/** Every distinct guard token appearing anywhere in a JSON value, in first-seen order. */
export function collectGuardTokens(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  function visit(node: unknown): void {
    if (typeof node === "string") {
      const pattern = guardTokenPattern();
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(node)) !== null) {
        if (!seen.has(match[0])) {
          seen.add(match[0]);
          found.push(match[0]);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node !== null && typeof node === "object") {
      // Object *keys* are not scanned: they are schema-defined field names, not
      // agent-authored data, and rewriting them would change the shape of the
      // call the tool receives.
      for (const item of Object.values(node)) visit(item);
    }
  }

  visit(value);
  return found;
}

/**
 * Rebuilds a JSON value with known tokens replaced. Never mutates its input:
 * `/gate` logs the original as `payloads.argsBefore`.
 */
export function substituteTokens(value: unknown, resolved: ReadonlyMap<string, string>): unknown {
  if (resolved.size === 0) return value;

  function visit(node: unknown): unknown {
    if (typeof node === "string") {
      const pattern = guardTokenPattern();
      return node.replace(pattern, (token) => resolved.get(token) ?? token);
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        out[key] = visit(item);
      }
      return out;
    }
    return node;
  }

  return visit(value);
}

/** Resolves one token to its original value, or `null` when it is not revealable. */
export type TokenResolver = (
  token: string,
  dataClass: DataClass,
) => Promise<string | null> | string | null;

export interface DetokenizeResult<T> {
  /** The value with known tokens substituted. Identical reference when nothing changed. */
  value: T;
  /** Tokens that were found and replaced. */
  replaced: string[];
  /** Tokens that were found but had no vault entry (left in place). */
  unresolved: string[];
}

/**
 * Finds every token in `value`, resolves each one exactly once, and returns a
 * substituted copy plus what happened, which `/gate` writes into the audit log.
 */
export async function detokenize<T>(
  value: T,
  resolve: TokenResolver,
): Promise<DetokenizeResult<T>> {
  const tokens = collectGuardTokens(value);
  if (tokens.length === 0) return { value, replaced: [], unresolved: [] };

  const resolved = new Map<string, string>();
  const unresolved: string[] = [];

  for (const token of tokens) {
    const parsed = parseGuardToken(token);
    // `collectGuardTokens` only emits well-formed tokens, so this is a
    // belt-and-braces guard rather than a real branch.
    if (parsed === null) {
      unresolved.push(token);
      continue;
    }

    const original = await resolve(token, parsed.dataClass);
    if (typeof original === "string") resolved.set(token, original);
    else unresolved.push(token);
  }

  return {
    value: substituteTokens(value, resolved) as T,
    replaced: [...resolved.keys()],
    unresolved,
  };
}
