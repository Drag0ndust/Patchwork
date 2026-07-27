/**
 * The Root Resolver: a PURE decision over artifact *listings*.
 *
 * Given what several configured source roots contain, it answers the only
 * question that matters — which artifact would Claude Code actually run? — and
 * reports the ones that lose so the UI can explain the shadowing.
 *
 * The precedence rules are deliberately asymmetric, because Claude Code's are:
 *
 * - **skills**: personal (`~/.claude`) beats project (`.claude`)
 * - **agents**: project (`.claude`) beats personal (`~/.claude`)
 *
 * No filesystem access here: listings come from the Import Scanner.
 */

import type { ArtifactKind } from "./artifact-codec";

export type RootRole = "personal" | "project";

export interface ArtifactListing {
  /** Symbolic id of the configured source root this listing came from. */
  rootId: string;
  role: RootRole;
  kind: ArtifactKind;
  name: string;
}

export interface ResolvedEntry<T extends ArtifactListing> {
  kind: ArtifactKind;
  name: string;
  /** The artifact Claude Code would run. */
  winner: T;
  /** Same-named artifacts that lose, strongest first. */
  shadowed: T[];
}

export interface Resolution<T extends ArtifactListing> {
  /** One entry per kind+name, in first-appearance order. */
  entries: ResolvedEntry<T>[];
  /** The subset of `entries` where at least one artifact was shadowed. */
  collisions: ResolvedEntry<T>[];
}

/** Lower rank wins. Skills prefer personal roots; agents prefer project ones. */
function precedenceRank(kind: ArtifactKind, role: RootRole): number {
  if (kind === "skill") return role === "personal" ? 0 : 1;
  return role === "project" ? 0 : 1;
}

/**
 * Resolve cross-root collisions. Within one role, the root listed first wins,
 * so callers control ties by the order they configure their roots in.
 */
export function resolveListings<T extends ArtifactListing>(
  listings: readonly T[],
): Resolution<T> {
  const groups = new Map<string, T[]>();
  for (const l of listings) {
    const key = `${l.kind}\u0000${l.name}`;
    const group = groups.get(key);
    if (group) group.push(l);
    else groups.set(key, [l]);
  }

  const entries: ResolvedEntry<T>[] = [];
  for (const group of groups.values()) {
    // Stable sort keeps first-listed roots ahead of later ones at equal rank.
    const ranked = [...group].sort(
      (a, b) =>
        precedenceRank(a.kind, a.role) - precedenceRank(b.kind, b.role),
    );
    const [winner, ...shadowed] = ranked;
    entries.push({ kind: winner.kind, name: winner.name, winner, shadowed });
  }

  return { entries, collisions: entries.filter((e) => e.shadowed.length > 0) };
}

/** Look up the winning entry for a kind+name, if the roots contain one. */
export function findResolved<T extends ArtifactListing>(
  resolution: Resolution<T>,
  kind: ArtifactKind,
  name: string,
): ResolvedEntry<T> | undefined {
  return resolution.entries.find((e) => e.kind === kind && e.name === name);
}
