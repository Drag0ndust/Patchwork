/**
 * The Artifact Codec: a PURE parser/emitter for the two on-disk artifact
 * formats Claude Code understands. No disk IO happens here — the Import
 * Scanner reads bytes, this module turns them into the model and back.
 *
 * The asymmetry between the two formats is encoded HERE so every other module
 * can stay agnostic:
 *
 * - a **skill** is a *directory* containing `SKILL.md`;
 * - an **agent** is a *single file* `agents/<name>.md`.
 *
 * For both, the **location is authoritative for the name** Claude Code invokes
 * them by (see [`parseArtifactLocation`]); frontmatter `name` is advisory and
 * reported when it disagrees, never silently applied.
 *
 * `emitArtifact(parseArtifact(source)) === source` byte-for-byte: the verbatim
 * frontmatter text and its delimiters are kept on the model, so re-emitting a
 * vendored artifact can never mangle a user's file.
 */

import { parse as parseYaml } from "yaml";

export type ArtifactKind = "skill" | "agent";

/**
 * One segment of a name. Each must survive being invoked by Claude Code and
 * rendered into an inline code span in the umbrella skill, so segments are
 * constrained to a safe charset and validated INDIVIDUALLY — anchoring only the
 * ends of the joined string would wave through `coding:-lead` and let a file
 * named `pr:reviewer.md` forge a namespace level.
 */
const NAME_SEGMENT_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/**
 * At most one namespace segment (the plugin directory) plus the artifact name:
 * the bounded layout the Import Scanner can actually resolve. A deeper name
 * could never be discovered, so accepting one would only let a hand-edited
 * document reference something unresolvable.
 */
const MAX_NAME_SEGMENTS = 2;

/**
 * Names end up inside an inline code span in the emitted `SKILL.md` and on the
 * canvas, so they are length-bounded too: a directory name can be as long as the
 * filesystem allows, and a 500-character one would wreck the umbrella's prose
 * without being a plausible artifact.
 *
 * The segment bound is exported because Patchwork also *produces* names that have
 * to survive being scanned back in: the bundle directory is a namespace segment,
 * so the Graph Document bounds the workflow name against this constant rather
 * than restating the number (see `MAX_BUNDLE_DIR_LENGTH`).
 */
export const MAX_NAME_SEGMENT_LENGTH = 64;
const MAX_NAME_LENGTH = 128;

/** True if `name` is usable as an artifact name (and safe to render inline). */
export function isValidArtifactName(name: string): boolean {
  if (name.length > MAX_NAME_LENGTH) return false;
  const segments = name.split(":");
  return (
    segments.length <= MAX_NAME_SEGMENTS &&
    segments.every(
      (segment) =>
        segment.length <= MAX_NAME_SEGMENT_LENGTH &&
        NAME_SEGMENT_PATTERN.test(segment),
    )
  );
}

/** The verbatim frontmatter segments, kept so emission is byte-faithful. */
export interface RawFrontmatter {
  /** Opening delimiter including its line ending, e.g. `"---\n"`. */
  open: string;
  /** The YAML text between the delimiters, without surrounding line endings. */
  text: string;
  /** Closing delimiter including the preceding and trailing line endings. */
  close: string;
}

export interface Artifact {
  kind: ArtifactKind;
  /** The name Claude Code invokes this artifact by. */
  name: string;
  description: string;
  /**
   * Every frontmatter key as parsed, including the optional ones
   * (`tools`, `model`, `effort`, ...). Nothing is silently dropped.
   */
  fields: Record<string, unknown>;
  /** The Markdown body after the frontmatter block, verbatim. */
  body: string;
  frontmatter: RawFrontmatter;
}

/**
 * The **canonical** location for an artifact of this kind, relative to a source
 * root — the layout Patchwork writes (and, later, vendor-copies) into:
 *
 * - `tdd` (skill) → `skills/tdd/SKILL.md`
 * - `coding:tdd` (skill) → `skills/coding/skills/tdd/SKILL.md`
 * - `reviewer` (agent) → `agents/reviewer.md`
 * - `coding:pr-reviewer` (agent) → `skills/coding/agents/pr-reviewer.md`
 *
 * `parseArtifactLocation(artifactRelativePath(kind, name))` always returns
 * `{kind, name}` again. The reverse does NOT hold in general: several real
 * layouts share one name (a plugin's own `skills/graphify/SKILL.md` and a flat
 * `skills/graphify/SKILL.md` are both `graphify`), so a *discovered* path is not
 * recoverable from its name. Use the scanned path when you need the real file.
 */
export function artifactRelativePath(kind: ArtifactKind, name: string): string {
  const segments = name.split(":");
  const leaf = segments.pop() as string;
  const plugin = segments[0];
  if (kind === "skill") {
    return plugin
      ? ["skills", plugin, "skills", leaf, "SKILL.md"].join("/")
      : ["skills", leaf, "SKILL.md"].join("/");
  }
  return plugin
    ? ["skills", plugin, "agents", `${leaf}.md`].join("/")
    : ["agents", `${leaf}.md`].join("/");
}

/** The file name that makes a directory a skill. */
const SKILL_FILE = "SKILL.md";

/**
 * Derive an artifact's kind and name from its path relative to a source root —
 * the pure statement of the rule the Import Scanner's walk implements, and the
 * only place the layout is written down on the TS side.
 *
 * The layout is deliberately **bounded**: at most one namespace segment, taken
 * from a plugin directory. Anything else is not an artifact — a plugin's
 * `references/`, a vendored dependency tree, arbitrary nesting. Treating unknown
 * directories as namespace segments would fabricate importable names like
 * `writing:excalidraw:references:vendored`, which resolve to nothing when the
 * umbrella skill asks Claude Code to invoke them.
 *
 * The walk additionally requires a `.claude-plugin/` marker directory before it
 * accepts a plugin — a filesystem fact this pure function cannot check, so the
 * shapes below are necessary but not quite sufficient. The shared table in
 * `__fixtures__/artifact-locations.json` drives both sides.
 */
export function parseArtifactLocation(
  relativePath: string,
): { kind: ArtifactKind; name: string } | null {
  const segments = relativePath.split("/").filter((s) => s !== "");
  const fileName = segments.pop();
  if (!fileName) return null;

  const [tree, ...rest] = segments;

  // agents/<name>.md
  if (tree === "agents" && rest.length === 0) {
    return agentAt(fileName, undefined);
  }
  if (tree !== "skills") return null;

  // skills/<name>/SKILL.md — also a plugin whose SKILL.md sits at its root.
  if (rest.length === 1 && fileName === SKILL_FILE) {
    return { kind: "skill", name: rest[0] };
  }
  // skills/<plugin>/skills/<name>/SKILL.md
  if (rest.length === 3 && rest[1] === "skills" && fileName === SKILL_FILE) {
    return { kind: "skill", name: `${rest[0]}:${rest[2]}` };
  }
  // skills/<plugin>/agents/<name>.md
  if (rest.length === 2 && rest[1] === "agents") {
    return agentAt(fileName, rest[0]);
  }
  return null;
}

function agentAt(
  fileName: string,
  plugin: string | undefined,
): { kind: ArtifactKind; name: string } | null {
  // A skill file misplaced in an agents directory must not claim a name.
  if (fileName === SKILL_FILE || !fileName.endsWith(".md")) return null;
  const stem = fileName.slice(0, -".md".length);
  return { kind: "agent", name: plugin ? `${plugin}:${stem}` : stem };
}

/**
 * Parse an artifact's file contents into the model.
 *
 * `locationName` is the name derived from the artifact's location on disk (see
 * [`parseArtifactLocation`]), and it is **authoritative** — see
 * [`declaredNameConflict`] for why frontmatter never overrides it.
 *
 * Throws an actionable error for anything malformed — a bad artifact must be
 * reported to the user, never silently skipped.
 */
export function parseArtifact(
  kind: ArtifactKind,
  source: string,
  locationName: string,
): Artifact {
  const label = `${kind} '${locationName}'`;
  const frontmatter = splitFrontmatter(source, label);
  const fields = parseFields(frontmatter.text, label);

  const description = fields.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(
      `Cannot import ${label}: it must declare a non-empty 'description' in its frontmatter (Claude Code uses it to decide when to invoke the artifact)`,
    );
  }

  const name = locationName;
  if (!isValidArtifactName(name)) {
    throw new Error(
      `Cannot import ${label}: '${name.slice(0, MAX_NAME_LENGTH)}' is not a usable artifact name (letters, digits, '.', '_' or '-' per segment; at most one ':' namespace segment; at most ${MAX_NAME_SEGMENT_LENGTH} characters per segment and ${MAX_NAME_LENGTH} overall)`,
    );
  }

  return {
    kind,
    name,
    description: description.trim(),
    fields,
    body: source.slice(
      frontmatter.open.length + frontmatter.text.length + frontmatter.close.length,
    ),
    frontmatter,
  };
}

/**
 * The frontmatter `name` this artifact declares, when it disagrees with the name
 * derived from its location — otherwise `undefined`.
 *
 * Why the location wins: it is the only source of the `<plugin>:` namespace (a
 * plugin's agents really do declare a bare `name: pr-reviewer`, so honouring the
 * declaration would strip the namespace and emit a dead reference), and letting
 * frontmatter rename an artifact would let one file claim the name of a
 * different, genuinely installed one.
 *
 * UNCERTAIN, deliberately: whether Claude Code prefers an agent's declared
 * `name` over its file stem when the two differ could not be established — every
 * agent observed in the wild has `name` == stem, so there is no evidence either
 * way. The conservative reading is taken (location wins) and the disagreement is
 * surfaced to the user by the Import Scanner rather than silently resolved. If
 * evidence turns up, this is the one place to change.
 */
export function declaredNameConflict(artifact: Artifact): string | undefined {
  const declared = artifact.fields.name;
  if (typeof declared !== "string") return undefined;
  const trimmed = declared.trim();
  if (trimmed === "" || trimmed === artifact.name) return undefined;
  // A bare declaration that matches the leaf is the normal plugin case, not a
  // conflict: `skills/coding/agents/pr-reviewer.md` declaring `pr-reviewer`.
  const leaf = artifact.name.split(":").pop();
  return trimmed === leaf ? undefined : trimmed;
}

/** Re-emit an artifact exactly as it was parsed. */
export function emitArtifact(artifact: Artifact): string {
  const { open, text, close } = artifact.frontmatter;
  return open + text + close + artifact.body;
}

/**
 * Locate the frontmatter block, keeping every byte of its delimiters.
 *
 * A leading byte-order mark is tolerated (a Windows-authored `SKILL.md` really
 * does start with one) and kept as part of the opening delimiter, so the file
 * still round-trips byte-for-byte instead of being rejected with a misleading
 * "missing frontmatter" error.
 */
function splitFrontmatter(source: string, label: string): RawFrontmatter {
  const open = ["---\n", "---\r\n", "﻿---\n", "﻿---\r\n"].find(
    (delimiter) => source.startsWith(delimiter),
  );
  if (!open) {
    throw new Error(
      `Cannot import ${label}: it is missing its YAML frontmatter block (the file must start with '---')`,
    );
  }

  const rest = source.slice(open.length);
  const close = rest.match(/(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!close || close.index === undefined) {
    throw new Error(
      `Cannot import ${label}: its frontmatter block is never closed (expected a second '---' line)`,
    );
  }

  return { open, text: rest.slice(0, close.index), close: close[0] };
}

/** Parse the frontmatter YAML into a mapping, reporting anything else. */
function parseFields(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    throw new Error(
      `Cannot import ${label}: malformed YAML frontmatter (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`,
    );
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Cannot import ${label}: its frontmatter must be a mapping of fields (found ${Array.isArray(parsed) ? "a list" : typeof parsed})`,
    );
  }
  return parsed as Record<string, unknown>;
}
