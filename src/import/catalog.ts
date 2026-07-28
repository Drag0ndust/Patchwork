/**
 * The Import Catalog: what the user can actually pick from.
 *
 * This is the PURE half of the Import Scanner. The privileged half is the Rust
 * `scan_roots` command, which walks the configured roots and hands back raw
 * artifact bytes; everything interesting happens here — parse each artifact with
 * the Artifact Codec, then let the Root Resolver decide which one Claude Code
 * would actually run.
 *
 * A single bad artifact is reported as a problem and skipped; it never takes the
 * rest of the import down with it.
 */

import {
  declaredNameConflict,
  parseArtifact,
  type Artifact,
  type ArtifactKind,
} from "../domain/artifact-codec";
import {
  resolveListings,
  type ArtifactListing,
  type ResolvedEntry,
} from "../domain/root-resolver";
import type { SourceRoot } from "./source-roots";

/** One raw artifact as returned by the Rust `scan_roots` command. */
export interface ScannedArtifact {
  /**
   * The id of the configured root it came from. Keyed by id, not path: a root's
   * identity is role + path, so attributing by path alone would erase the role
   * and make `skills personal > project` unappliable.
   */
  rootId: string;
  kind: string;
  name: string;
  path: string;
  contents: string;
}

export interface ScanReport {
  artifacts: ScannedArtifact[];
  problems: string[];
}

/** A parsed, root-attributed artifact that a node can be bound to. */
export interface CatalogArtifact extends ArtifactListing {
  /** Absolute path on disk — for display only; documents store the root id. */
  path: string;
  artifact: Artifact;
}

export interface ImportCatalog {
  /** The winning artifact per kind+name, in scan order. */
  artifacts: CatalogArtifact[];
  /** Kind+name that exist in more than one root, with the winner named. */
  collisions: ResolvedEntry<CatalogArtifact>[];
  /** Roots that could not be read, artifacts that could not be parsed, etc. */
  problems: string[];
}

/**
 * How many problems reach the UI, and how long an interpolated value may be.
 *
 * The Rust side caps its own problems per root, but everything discovered here
 * (a parse failure, a declared-name conflict) is per artifact, so without a cap
 * 500 broken artifacts would become 500 notice lines. And every value woven into
 * a problem string comes from a file on disk: a 200 KB `name:` or one containing
 * newlines must not be able to blow up or reflow the notices.
 */
const MAX_PROBLEMS = 20;
const MAX_VALUE_LENGTH = 120;

/**
 * Collisions are notices as well, and a personal root plus a project root that
 * vendors the same plugin set collide on *every* artifact — the exact overlap the
 * notice exists to report. So the same bounds apply: how many collisions are
 * described, and how many shadowers are named per line.
 */
const MAX_COLLISIONS_DESCRIBED = 20;
const MAX_SHADOWERS_DESCRIBED = 3;

/** Collapse whitespace and truncate an untrusted value for display. */
export function displayValue(value: unknown, max = MAX_VALUE_LENGTH): string {
  const text = typeof value === "string" ? value : String(value);
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  let cut = collapsed.slice(0, max);
  // Slicing counts UTF-16 code units, so a truncation can land between the two
  // halves of a surrogate pair and leave a lone half that renders as U+FFFD.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Collects problems, bounded, with a summarizing tail like the Rust side. */
class Problems {
  private readonly kept: string[] = [];
  private suppressed = 0;

  add(message: string): void {
    if (this.kept.length < MAX_PROBLEMS) this.kept.push(displayValue(message, 400));
    else this.suppressed += 1;
  }

  addAll(messages: readonly string[]): void {
    for (const message of messages) this.add(message);
  }

  toArray(): string[] {
    return this.suppressed > 0
      ? [...this.kept, `…and ${this.suppressed} more import problem(s)`]
      : [...this.kept];
  }
}

export const EMPTY_CATALOG: ImportCatalog = {
  artifacts: [],
  collisions: [],
  problems: [],
};

/** Parse and resolve a raw scan report against the roots that produced it. */
export function buildCatalog(
  roots: readonly SourceRoot[],
  report: ScanReport,
): ImportCatalog {
  const problems = new Problems();
  problems.addAll(report.problems);
  const byId = new Map(roots.map((r) => [r.id, r]));
  const listings: CatalogArtifact[] = [];

  for (const scanned of report.artifacts) {
    const root = byId.get(scanned.rootId);
    if (!root) {
      problems.add(
        `Ignored '${displayValue(scanned.name)}' from '${displayValue(scanned.rootId)}', which is not a configured source root`,
      );
      continue;
    }
    if (scanned.kind !== "skill" && scanned.kind !== "agent") {
      problems.add(
        `Ignored '${displayValue(scanned.name)}' from '${displayValue(root.path)}': unknown artifact kind '${displayValue(scanned.kind)}'`,
      );
      continue;
    }
    const kind = scanned.kind as ArtifactKind;

    try {
      const artifact = parseArtifact(kind, scanned.contents, scanned.name);
      const declared = declaredNameConflict(artifact);
      if (declared !== undefined) {
        const name = displayValue(artifact.name);
        problems.add(
          `${kind} '${name}' declares the name '${displayValue(declared)}' in its frontmatter; Patchwork uses '${name}', the name derived from ${displayValue(scanned.path)}`,
        );
      }
      listings.push({
        rootId: root.id,
        role: root.role,
        kind,
        name: artifact.name,
        path: scanned.path,
        artifact,
      });
    } catch (e) {
      // Codec errors quote the artifact's own fields, so they are untrusted too.
      problems.add(displayValue(e instanceof Error ? e.message : String(e), 400));
    }
  }

  const resolution = resolveListings(listings);
  return {
    artifacts: resolution.entries.map((e) => e.winner),
    collisions: resolution.collisions,
    problems: problems.toArray(),
  };
}

/** The artifact a `skill`/`agent` node's reference resolves to, if any. */
export function findCatalogArtifact(
  catalog: ImportCatalog,
  kind: ArtifactKind,
  name: string,
): CatalogArtifact | undefined {
  return catalog.artifacts.find((a) => a.kind === kind && a.name === name);
}

/** Artifacts of one kind, for a picker. */
export function catalogArtifactsOfKind(
  catalog: ImportCatalog,
  kind: ArtifactKind,
): CatalogArtifact[] {
  return catalog.artifacts.filter((a) => a.kind === kind);
}

/** An explanation of which artifact won a collision, and what it shadows. */
export function describeCollision(
  entry: ResolvedEntry<CatalogArtifact>,
): string {
  const named = entry.shadowed.slice(0, MAX_SHADOWERS_DESCRIBED);
  const rest = entry.shadowed.length - named.length;
  const shadowed = named
    .map((s) => `${displayValue(s.path)} (root ${displayValue(s.rootId)})`)
    .join(", ");
  const more = rest > 0 ? ` and ${rest} more` : "";
  return `${entry.kind} '${displayValue(entry.name)}': using ${displayValue(entry.winner.path)} from root ${displayValue(entry.winner.rootId)} (${entry.winner.role} wins for a ${entry.kind}); shadows ${shadowed}${more}`;
}

/**
 * Describe the collisions for display, bounded the same way problems are, with a
 * summarizing tail when there are more than fit.
 */
export function describeCollisions(
  collisions: readonly ResolvedEntry<CatalogArtifact>[],
): string[] {
  const described = collisions
    .slice(0, MAX_COLLISIONS_DESCRIBED)
    .map(describeCollision);
  const rest = collisions.length - described.length;
  return rest > 0
    ? [...described, `…and ${rest} more shadowed artifact(s)`]
    : described;
}
