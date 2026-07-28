/**
 * Configured source roots: the places Patchwork imports skills and agents from.
 *
 * A root is referenced **symbolically** everywhere else (by `id`), never by an
 * absolute path, so a `.patchwork` document stays portable and precedence
 * resolution can re-run on open. Ids are derived from role + path, which keeps
 * them stable across sessions and machines for the default `~/.claude` root.
 *
 * Pure module: paths are strings here, and nothing touches the filesystem.
 */

import type { RootRole } from "../domain/root-resolver";

export interface SourceRoot {
  id: string;
  /** The configured path, kept verbatim — `~` is expanded during the scan. */
  path: string;
  role: RootRole;
}

/** The default configuration: the user's personal `~/.claude`, scanned always. */
export const DEFAULT_SOURCE_ROOTS: readonly SourceRoot[] = [
  { id: "personal:~/.claude", path: "~/.claude", role: "personal" },
];

/** How many roots may be configured; also bounds what a restore can inject. */
export const MAX_SOURCE_ROOTS = 16;

/**
 * Normalize a configured path for **identity**: trailing separators and repeated
 * separators carry no meaning, so `~/.claude/` and `~/.claude` are one root.
 *
 * Absolute-versus-`~` is normalized at the edge instead: [`tildeify`] is applied
 * to whatever the folder picker returns, so a user picking their own
 * `/Users/me/.claude` lands on the same `~/.claude` the default root uses rather
 * than adding a second root over the same directory.
 *
 * What string normalization cannot see — symlinked aliases, and case-insensitive
 * filesystems where `/users/me` and `/Users/ME` are one directory — is caught by
 * the scanner, which refuses to read one *resolved* directory twice. Such a pair
 * therefore shows as two configured rows plus one notice, rather than as a tree
 * imported twice colliding with itself.
 */
export function normalizeRootPath(path: string): string {
  const collapsed = path.trim().replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/** Rewrite a path inside `home` to its portable `~`-relative form. */
export function tildeify(path: string, home: string | null | undefined): string {
  const normalized = normalizeRootPath(path);
  const base = home ? normalizeRootPath(home) : "";
  if (base === "" || normalized === base) return base === "" ? normalized : "~";
  return normalized.startsWith(`${base}/`)
    ? `~${normalized.slice(base.length)}`
    : normalized;
}

/** A stable identity for a configured root: its role plus its normalized path. */
export function sourceRootId(role: RootRole, path: string): string {
  return `${role}:${normalizeRootPath(path)}`;
}

/**
 * Why an add did or did not change the configuration.
 *
 * The three no-op cases are **not** interchangeable to a user: a duplicate means
 * the root is already there, at-capacity means their root was refused, and an
 * empty path means the picker gave nothing. `addSourceRoot` is identity-stable
 * for all three, so a caller cannot tell them apart from the returned array —
 * which is how a refused add came to report success.
 */
export type AddRootOutcome = "added" | "duplicate" | "at-capacity" | "empty-path";

/**
 * Classify what `addSourceRoot` will do with these arguments, so the rules live
 * in exactly one place and a caller's message cannot drift from the behaviour.
 */
export function classifyAddSourceRoot(
  roots: readonly SourceRoot[],
  path: string,
  role: RootRole,
): AddRootOutcome {
  const normalized = normalizeRootPath(path);
  if (normalized === "") return "empty-path";
  if (roots.some((r) => r.id === sourceRootId(role, normalized))) return "duplicate";
  if (roots.length >= MAX_SOURCE_ROOTS) return "at-capacity";
  return "added";
}

/**
 * Add a root, ignoring an exact duplicate. Order is meaningful: the Root
 * Resolver breaks same-role ties by which root was configured first.
 *
 * Never mutates, and returns the **same array** when nothing changes, so a
 * no-op add cannot pass as a state change and trigger a needless rescan (which
 * would also wipe the status line explaining that nothing changed). Callers that
 * need to *report* what happened must ask [`classifyAddSourceRoot`] — the array
 * alone cannot distinguish a duplicate from a refusal.
 */
export function addSourceRoot(
  roots: readonly SourceRoot[],
  path: string,
  role: RootRole,
): SourceRoot[] {
  const unchanged = roots as SourceRoot[];
  if (classifyAddSourceRoot(roots, path, role) !== "added") return unchanged;
  const normalized = normalizeRootPath(path);
  return [...roots, { id: sourceRootId(role, normalized), path: normalized, role }];
}

/** Remove a root; identity-stable when `id` is not configured. */
export function removeSourceRoot(
  roots: readonly SourceRoot[],
  id: string,
): SourceRoot[] {
  return roots.some((r) => r.id === id)
    ? roots.filter((r) => r.id !== id)
    : (roots as SourceRoot[]);
}

/** Serialize the root configuration for persistence between sessions. */
export function serializeSourceRoots(roots: readonly SourceRoot[]): string {
  return JSON.stringify(roots);
}

/**
 * Restore a persisted root configuration, falling back to the defaults for
 * anything unusable. Bad settings must never stop the app from starting.
 */
export function parseSourceRoots(json: string | null): SourceRoot[] {
  if (!json) return [...DEFAULT_SOURCE_ROOTS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [...DEFAULT_SOURCE_ROOTS];
  }
  if (!Array.isArray(parsed)) return [...DEFAULT_SOURCE_ROOTS];

  // Ids are recomputed rather than trusted, so a value stored before the current
  // normalization (or hand-edited) cannot smuggle in a duplicate identity.
  const roots: SourceRoot[] = [];
  for (const candidate of parsed.slice(0, MAX_SOURCE_ROOTS)) {
    if (!isSourceRoot(candidate)) continue;
    const path = normalizeRootPath(candidate.path);
    if (path === "") continue;
    const id = sourceRootId(candidate.role, path);
    if (roots.some((r) => r.id === id)) continue;
    roots.push({ id, path, role: candidate.role });
  }
  return roots.length > 0 ? roots : [...DEFAULT_SOURCE_ROOTS];
}

function isSourceRoot(value: unknown): value is SourceRoot {
  if (typeof value !== "object" || value === null) return false;
  const root = value as Record<string, unknown>;
  return (
    typeof root.id === "string" &&
    typeof root.path === "string" &&
    (root.role === "personal" || root.role === "project")
  );
}
