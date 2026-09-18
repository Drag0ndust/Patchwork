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

import { Document, parse as parseYaml, Scalar, visit } from "yaml";

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

/**
 * The names NTFS refuses whatever the extension: the MS-DOS device names, which
 * Windows still resolves *before* it looks at the directory. `NUL`, `nul.md` and
 * `NUL.log` are all the null device, so `agents/NUL.md` and `skills/CON/` cannot be
 * created on a Windows machine at all.
 *
 * Checked only where Patchwork *mints* a name — an artifact authored in the graph
 * (see [`isValidAuthoredArtifactName`]). An artifact discovered on disk under one of
 * these names already exists, and refusing to import it would be refusing a file the
 * user is looking at.
 *
 * A trailing dot or space is the other NTFS constraint, and it needs no rule here:
 * `NAME_SEGMENT_PATTERN` already requires a name to end in a letter or a digit.
 */
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/**
 * True if `name` is one Patchwork may **author** an artifact under.
 *
 * Stricter than [`isValidArtifactName`] in two ways, and both come from the fact that
 * this name is invented by a user rather than read off a real file:
 *
 * - it must be a **single segment**. An authored artifact is written bare into the
 *   bundle, whose directory is already its namespace (ADR-0002), so a name carrying a
 *   `<plugin>:` of its own would land at a path whose leaf is not the name the file
 *   declares — a file Patchwork's own Import Scanner would flag as a declared-name
 *   conflict, written by Patchwork;
 * - it must not be a Windows device name (see [`RESERVED_DEVICE_NAME`]).
 */
export function isValidAuthoredArtifactName(name: string): boolean {
  if (name.includes(":") || RESERVED_DEVICE_NAME.test(name)) return false;
  return isValidArtifactName(name);
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

/**
 * The two scalars a YAML **1.1** reader gives a meaning of its own that the `yaml`
 * package's emitter leaves bare even in 1.1 mode: `=` is the value tag (PyYAML raises
 * "could not determine a constructor" on it) and `<<` is the merge key.
 *
 * Everything else ambiguous under 1.1 — `yes`/`no`/`on`/`off`, `1:30`, `0b101`,
 * `1_000`, a bare date — the emitter quotes for us once it is told which version it is
 * writing for. These two it does not, so they are named.
 */
const YAML_1_1_SPECIAL_SCALARS = new Set(["=", "<<"]);

/**
 * The characters that must never reach the file raw, **derived from the YAML spec
 * rather than enumerated from what has broken so far**.
 *
 * Three rounds of review each found one more member of this set by hand — `U+2028`,
 * then the C1 block, then TAB — because the set was being written down as a list of
 * offenders, and a list of offenders is only ever as complete as the last person to
 * look. So the rule is taken from the production every reader implements:
 *
 * ```
 * c-printable ::= #x9 | #xA | #xD | [#x20-#x7E]                  // 8 bit
 *               | #x85 | [#xA0-#xD7FF] | [#xE000-#xFFFD]         // 16 bit
 *               | [#x10000-#x10FFFF]                             // 32 bit
 * ```
 *
 * A character is escaped when **either** half of this holds:
 *
 * 1. **it is not `c-printable`.** Readers apply the production as a filter over the
 *    whole stream, before any parsing: PyYAML 6 refuses the block with "unacceptable
 *    character #x0080: special characters are not allowed", Psych 5 with "control
 *    characters are not allowed". This one clause covers the C0 controls, `DEL`, the
 *    entire C1 block and the two BMP non-characters `U+FFFE`/`U+FFFF` — the members the
 *    earlier rounds each found one at a time — without naming any of them;
 * 2. **it is `c-printable` but unsafe in the style the emitter picks.** Two cases, and
 *    they are the whole of the exception:
 *    - **TAB** (`#x9`). A plain scalar may not contain one (`ns-plain-char` excludes
 *      `s-white`), and the `yaml` package writes it bare into a plain scalar, which is
 *      simply invalid YAML: PyYAML stops at "found character that cannot start any
 *      token". Psych accepts it, which is why a Psych-only check cannot see this one;
 *    - **`U+0085` (NEL)** and **`U+2028`/`U+2029`**, the YAML **1.1** line-break class,
 *      which the emitter writes raw even inside double quotes. A raw `U+2028` ends the
 *      line halfway through the mapping and both readers refuse the whole block; a raw
 *      `U+0085` is milder and worse — it parses, folded to a space, so the description
 *      on disk is quietly not the one the author wrote.
 *
 * What is deliberately **outside** the set, each for a reason a future reader can check
 *  against the production rather than take on trust:
 *
 * - **LF and CR.** Both are `c-printable`, and both are the line breaks the format is
 *   made of. The emitter already represents them faithfully (escaped, inside double
 *   quotes), and escaping LF here would rewrite the document's own structure, because
 *   [`escapeYamlRawUnsafe`] runs over the whole emitted text;
 * - **`U+FDD0`–`U+FDEF` and `U+FEFF`.** Unicode non-characters and the BOM, but squarely
 *   inside `[#xE000-#xFFFD]`; both readers accept them and hand them back exactly;
 * - **everything astral.** `[#x10000-#x10FFFF]` is admitted whole — the production does
 *   *not* carve the plane-end non-characters out of it, and neither reader refuses
 *   `U+1FFFE`. So no escape this rule produces is ever above the BMP, which is what lets
 *   [`escapeYamlRawUnsafe`] always write four hex digits.
 *
 * **Lone surrogates** (`#xD800`–`#xDFFF`) are out of scope, and the rule leaves them to
 * the emitter on purpose. The production excludes them, so clause 1 does match one — but
 * nothing rides on that: inside a double-quoted scalar the `yaml` package already writes
 * `\ud800` itself, so the same bytes come out either way. Nor does any input path produce
 * one: a JS string holds a surrogate only as the two halves of a pair, and the `u` flag
 * makes the classes below code-**point** classes, so a valid pair (an emoji) is one unit
 * and is never matched half-way. An unpaired one could not reach a file in any case —
 * Node writes `U+FFFD` for it when it encodes UTF-8.
 *
 * The three constants below *are* that rule: the production transcribed term for term
 * so the two can be read side by side, the clause-2 exceptions, and their union. The
 * suite sweeps the union through the real emitter against PyYAML *and* Psych at every
 * boundary the production names; see the sweep in `artifact-codec.test.ts`.
 */
const C_PRINTABLE =
  "\\u0009\\u000a\\u000d\\u0020-\\u007e\\u0085\\u00a0-\\ud7ff\\ue000-\\ufffd\\u{10000}-\\u{10ffff}";

/** Clause 2: inside `c-printable`, still unsafe raw in the style the emitter picks. */
const C_PRINTABLE_BUT_UNSAFE_RAW = "\\u0009\\u0085\\u2028\\u2029";

/** The rule itself: clause 1 or clause 2, over code **points** (hence the `u` flag). */
const YAML_RAW_UNSAFE = new RegExp(`[^${C_PRINTABLE}]|[${C_PRINTABLE_BUT_UNSAFE_RAW}]`, "u");
const YAML_RAW_UNSAFE_GLOBAL = new RegExp(YAML_RAW_UNSAFE.source, "gu");

/**
 * Render those characters as `\uXXXX` escapes.
 *
 * **Escaped, not stripped and not merely quoted**, and each half of that is a
 * decision. Quoting alone does not help: the emitter puts the raw character inside the
 * quotes, where a reader still ends the line on it or refuses it outright. Stripping at input would make
 * the emitted file unambiguous by deleting something the author typed — lossy, silent,
 * and unavailable to a round trip. An escape is the one form that is text to every
 * reader of either version and gives the exact character back, so
 * `parseArtifact(emitArtifact(...))` stays an equality.
 *
 * Applying it to the whole emitted document is safe because [`stringifyFrontmatter`]
 * force-quotes every scalar that contains one first: after that pass, every occurrence
 * left in the output is inside a double-quoted scalar, which is the only context where
 * `\uXXXX` means the character rather than six literal ones. Four hex digits always
 * suffice: [`YAML_RAW_UNSAFE`] matches nothing above the BMP, so this never has to write
 * the eight-digit form (or, worse, a surrogate half a reader would refuse).
 */
function escapeYamlRawUnsafe(text: string): string {
  return text.replace(
    YAML_RAW_UNSAFE_GLOBAL,
    (c) => `\\u${(c.codePointAt(0) as number).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Emit frontmatter fields as YAML that means the same thing to **every** reader.
 *
 * The version is the whole point. The `yaml` package defaults to YAML 1.2, whose core
 * schema has no `yes`/`no` booleans and no sexagesimal integers, so it emits
 * `description: yes` — correct 1.2, and read back by PyYAML (1.1, and what Claude
 * Code's ecosystem is full of) as the boolean `True`. A description of `1:30` comes
 * back as `90`. Emitting *for* 1.1 makes the file unambiguous to the stricter reader
 * of the two and is still read as text by a 1.2 one, because a quoted string is a
 * quoted string in both.
 *
 * Quoting is decided per value rather than applied to every scalar: an emitted artifact
 * is a file its author reads and edits, and blanket quotes would make all of them read
 * like machine output. The merge tag is dropped from the schema for the same reason —
 * with it in place, forcing quotes on `<<` emitted an explicit `!!str` tag instead.
 *
 * `lineWidth: 0` disables folding, so a long *plain* description stays one line instead
 * of being wrapped into something that reads differently. It is not a promise that no
 * scalar is ever wrapped: a long double-quoted one still gets `\`-continuations, which
 * is legal YAML that both readers reconstruct exactly — do not build on the stronger
 * reading.
 */
export function stringifyFrontmatter(fields: Record<string, unknown>): string {
  const doc = new Document(fields, {
    version: "1.1",
    // The schema's tag list may hold shorthands as well as tag objects; only an
    // object can be the merge tag.
    customTags: (tags) =>
      tags.filter((tag) => typeof tag === "string" || tag.tag !== "tag:yaml.org,2002:merge"),
  });
  visit(doc, {
    Scalar(_key, node) {
      if (
        typeof node.value === "string" &&
        (YAML_1_1_SPECIAL_SCALARS.has(node.value) || YAML_RAW_UNSAFE.test(node.value))
      ) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return escapeYamlRawUnsafe(doc.toString({ lineWidth: 0 }));
}

/**
 * Drop the trailing newline(s) a YAML emitter ends its document with.
 *
 * A loop rather than `/\n+$/`: anchoring a greedy run at the end of the string makes
 * the engine match a run of newlines *anywhere* and then backtrack the whole way once
 * `$` fails, which is quadratic in the newlines the emitted block scalar contains. A
 * description with 200,000 of them took 57 seconds to strip one character — on the
 * renderer's main thread. `trimEnd` is not a substitute here: it would also eat
 * trailing spaces and tabs, which are part of the emitted YAML.
 *
 * Exported because both emitters of frontmatter — this module's authored artifacts and
 * the Graph Compiler's umbrella — end a [`stringifyFrontmatter`] call the same way.
 */
export function stripTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === "\n") end -= 1;
  return text.slice(0, end);
}

/**
 * A field of an authored spec, read as the text it is meant to be.
 *
 * `composeArtifact` is on the compile path, which is asked of in-memory node data a
 * hand edit may have made nonsense of and may never throw (issue #27): a number where
 * a description belongs is a description with nothing in it, which is what
 * `validateGraph` already says in the words of the node.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * An artifact **authored in the graph**: the fields a form collects, before there
 * is a file anywhere.
 *
 * Deliberately not an `Artifact`. An imported artifact's model carries the
 * verbatim frontmatter its file had, because emitting it back must not mangle a
 * user's bytes; an authored one has no file to be faithful to, so it is stored as
 * *structured fields plus a body* and its frontmatter is **derived** — which is
 * what makes "the form is the artifact" true, and what makes the emitted YAML
 * valid by construction rather than by the author's typing. See ADR-0007.
 *
 * The optional fields are the **curated** surface, not the whole of what Claude
 * Code reads: they are the three an author actually sets (which tools the artifact
 * may use, which model runs it, how hard it thinks), and each one is omitted
 * entirely when it is blank — see [`composeArtifact`].
 */
export interface AuthoredArtifactSpec {
  kind: ArtifactKind;
  /** The name the artifact is invoked by, and the name its location must yield. */
  name: string;
  description: string;
  tools?: string;
  model?: string;
  effort?: string;
  /** The Markdown below the frontmatter, as the author wrote it. */
  body: string;
}

/**
 * Turn authored fields into an [`Artifact`], so that authored and imported
 * artifacts leave the codec by the **same** emit path.
 *
 * `emitArtifact(composeArtifact(spec))` is a file `parseArtifact` reads back into
 * an equal artifact — the property the round-trip tests pin, and the reason the
 * frontmatter is produced by a real YAML emitter rather than by string
 * concatenation: a description containing a colon, a quote, a leading `-`, or a
 * line of its own `---` would otherwise emit a file that is not the artifact the
 * author wrote.
 *
 * **Total, on purpose.** It is called from the Graph Compiler, which may never
 * throw on a half-finished document (issue #27): an authored node with no
 * description yet composes into an artifact with no description, and it is
 * `validateGraph` that refuses the export — in the words of the node the user has
 * to fix, rather than as an exception from the emitter.
 */
export function composeArtifact(spec: AuthoredArtifactSpec): Artifact {
  const name = asText(spec.name).trim();
  const description = asText(spec.description).trim();
  // Insertion order *is* the emitted order, and it is the order the artifacts in
  // the wild use: what it is called, when to use it, then how it is run.
  const fields: Record<string, unknown> = { name, description };
  for (const [key, value] of [
    ["tools", spec.tools],
    ["model", spec.model],
    ["effort", spec.effort],
  ] as const) {
    const written = asText(value).trim();
    // Omitted rather than emitted empty: `tools:` with nothing after it is a
    // declared key with a null value, which is a claim the author never made.
    if (written !== "") fields[key] = written;
  }

  const text = stripTrailingNewlines(stringifyFrontmatter(fields));
  // A blank line between the frontmatter and the body, which is what every
  // artifact on disk looks like — and no trailing blank run, so re-emitting an
  // unedited authored artifact is stable.
  //
  // `trimEnd` rather than `/\s+$/`, for the reason [`stripTrailingNewlines`] is a
  // loop: an unanchored greedy run before `$` is quadratic in the length of the run,
  // and a 100,000-character whitespace run in a body — a paste, not an attack — froze
  // the export for 16 seconds on the renderer's main thread. `trimEnd` removes exactly
  // the same characters (`\s` and the trim set are one set) in linear time. The
  // leading pattern is anchored, so it has no such shape.
  const body = asText(spec.body).replace(/^\s*\n/, "").trimEnd();

  return {
    kind: spec.kind,
    name,
    description,
    fields,
    body: body === "" ? "" : `\n${body}\n`,
    frontmatter: { open: "---\n", text, close: "\n---\n" },
  };
}
