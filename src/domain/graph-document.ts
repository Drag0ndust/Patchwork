/**
 * The Graph Document: Patchwork's own persisted `.patchwork` schema.
 *
 * This is deliberately NOT React Flow's internal JSON. React Flow node
 * positions are kept under an optional `position` field for round-tripping the
 * canvas, but the document itself is the source of truth for compilation.
 */

import {
  isValidArtifactName,
  MAX_NAME_SEGMENT_LENGTH,
  type ArtifactKind,
} from "./artifact-codec";

/**
 * Bumped to 3 in slice 3: a `skill`/`agent` node now records *how* it is
 * exported — referenced by name, or vendor-copied into the bundle.
 * `deserialize` migrates older documents forward.
 */
export const CURRENT_SCHEMA_VERSION = 3;

/** The oldest document version that still opens (via forward migration). */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export type NodeType = "input" | "prompt" | "output" | "skill" | "agent";

const NODE_TYPES: NodeType[] = ["input", "prompt", "output", "skill", "agent"];

/** The `skill`/`agent` node types map 1:1 onto the codec's artifact kinds. */
export function artifactKindOf(type: NodeType): ArtifactKind | null {
  return type === "skill" || type === "agent" ? type : null;
}

export interface Parameter {
  name: string;
  description?: string;
}

export interface InputData {
  parameters: Parameter[];
}

export interface PromptData {
  instruction: string;
}

export interface OutputData {
  description: string;
}

/**
 * A `skill`/`agent` node's binding to an artifact that lives in one of the
 * user's source roots.
 *
 * The reference is deliberately **symbolic**: the artifact's name plus the id
 * of the configured root it was imported from — never an absolute path. That
 * way precedence resolution re-runs every time the document is opened, and a
 * moved or removed root leaves the node unresolved instead of stale.
 */
export interface ArtifactRefData {
  name: string;
  rootId: string;
  /**
   * How the export treats this node. Optional on the *type* only so that a v2
   * document and a hand-edited one are both readable without a repair step —
   * every path that needs the value goes through [`exportModeOf`], and the UI
   * always writes one.
   */
  exportMode?: ExportMode;
}

/**
 * What an export does with a `skill`/`agent` node's artifact.
 *
 * - `reference` — name it in the umbrella's prose and copy nothing, so the
 *   artifact must already be installed in Claude Code.
 * - `vendor` — copy the artifact's bytes into the bundle, so the workflow
 *   carries its dependency and runs on a machine that never had it.
 */
export type ExportMode = "reference" | "vendor";

const EXPORT_MODES: ExportMode[] = ["reference", "vendor"];

/**
 * Reference-by-name is the default everywhere: it is what slice 2 did, so a
 * document that predates the choice (or omits it) exports byte-identically to
 * before, and the more surprising behaviour — copying someone else's file into a
 * bundle — is never chosen on a user's behalf.
 */
export const DEFAULT_EXPORT_MODE: ExportMode = "reference";

/** The export mode a `skill`/`agent` node's stored reference asks for. */
export function exportModeOf(data: ArtifactRefData): ExportMode {
  return data.exportMode ?? DEFAULT_EXPORT_MODE;
}

export type NodeData = InputData | PromptData | OutputData | ArtifactRefData;

export interface Position {
  x: number;
  y: number;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  data: NodeData;
  position?: Position;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowMeta {
  name: string;
  description?: string;
}

/**
 * Turn a workflow name into a filesystem/skill-safe slug. Falls back to
 * `"workflow"` so `name`/`dirName` are never empty even for punctuation-only or
 * non-ASCII names (validation rejects those at export; this is defence in depth).
 *
 * Lives here, beside the name it derives from, because both the Graph Compiler
 * (which builds the bundle directory out of it) and `validateGraph` (which has to
 * bound its *length*) need it, and the length is not the name's: `toLowerCase`
 * can expand a character — see the note on [`MAX_BUNDLE_DIR_LENGTH`].
 */
export function slugify(name: string): string {
  return rawSlug(name) || "workflow";
}

/**
 * The slug before the fallback — empty exactly when the name has nothing to build a
 * file name out of.
 *
 * Separate from [`slugify`] so `validateGraph` can tell "slugs to nothing" from "slugs
 * to `workflow`" (a name that *is* `workflow` is fine) without re-deriving the rule.
 * Asking this rather than testing the name against `[a-z0-9]` matters because the slug
 * comes off the *lowercased* name, and lowercasing can make a character usable: `İ`
 * (U+0130) is not `[a-z0-9]`, yet it slugs to `i`.
 */
function rawSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The longest single path component the common filesystems accept. */
const MAX_PATH_COMPONENT_LENGTH = 255;

/**
 * What the Bundle Emitter's own longest name adds to the bundle directory name.
 *
 * An export is written through a staging sibling and retires the previous bundle
 * under a second one (`write_bundle`/`staging_name` in `src-tauri/src/lib.rs`), so
 * the name that actually has to fit a path component is
 * `.<dirName>.patchwork-previous-<pid>-<nanos>`:
 *
 * | part                  | worst case                        | chars |
 * | --------------------- | --------------------------------- | ----- |
 * | leading `.`           |                                   | 1     |
 * | `.patchwork-`         |                                   | 11    |
 * | role                  | `previous`                        | 8     |
 * | `-` + process id      | a 32-bit pid                      | 11    |
 * | `-` + epoch nanos     | 19 digits until the year 2286     | 20    |
 */
const EMITTER_NAME_COST = 1 + 11 + 8 + 11 + 20;

/** The prefix `compile` puts in front of the slug to form the bundle directory. */
export const BUNDLE_DIR_PREFIX = "patchwork-";

/**
 * What the *filesystem* allows the bundle directory to be called, once the room
 * the Bundle Emitter's own temporary names need is taken out.
 *
 * Bounded here rather than left to the emitter because the failure otherwise
 * surfaces at the far end of the export, as the operating system's "File name too
 * long" naming a temporary directory the user has never seen and cannot connect to
 * the name they typed.
 */
const MAX_BUNDLE_DIR_PATH_LENGTH = MAX_PATH_COMPONENT_LENGTH - EMITTER_NAME_COST;

/**
 * How long the exported bundle's directory name may be.
 *
 * Two independent bounds meet here, and the *smaller* is the rule:
 *
 * - the filesystem's, via [`MAX_BUNDLE_DIR_PATH_LENGTH`];
 * - **discoverability's.** The bundle directory is not only a directory: dropped
 *   into a source root it is the name Claude Code discovers the umbrella skill by,
 *   and — when the bundle vendors anything — the plugin namespace every bundled
 *   capability is invoked under (`patchwork-<slug>:tdd`). Both are *artifact name
 *   segments*, so a directory the Import Scanner would reject is an export that
 *   succeeds and then resolves to nothing. That is the binding one today, by a
 *   wide margin.
 *
 * This — not the length of the name as typed — is the limit, because the one field
 * that becomes a *filename* becomes it via `slugify`, and a slug is not the same
 * length as its name in either direction:
 *
 * - **Longer.** `toLowerCase` can expand a character. `İ` (U+0130, on every Turkish
 *   keyboard) becomes `i` + U+0307, and the combining mark is not `[a-z0-9]`, so
 *   each one slugs to `i-`: a 29-character name can produce a 66-character
 *   directory. It is the only such code point, and one is enough.
 * - **Shorter.** 250 spaces slug to nothing at all, so a name-length rule would
 *   refuse names that export perfectly well.
 */
export const MAX_BUNDLE_DIR_LENGTH = Math.min(
  MAX_BUNDLE_DIR_PATH_LENGTH,
  MAX_NAME_SEGMENT_LENGTH,
);

/** The longest name that is safe whatever it contains — for advice, not the rule. */
export const MAX_WORKFLOW_NAME_LENGTH =
  MAX_BUNDLE_DIR_LENGTH - BUNDLE_DIR_PREFIX.length;

export interface PatchworkDocument {
  schemaVersion: number;
  workflow: WorkflowMeta;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

/**
 * Validate a document as a well-formed linear workflow.
 *
 * Errors are actionable (they name the offending node/edge and what is wrong)
 * so the UI can surface them directly.
 */
export function validateGraph(doc: PatchworkDocument): ValidationResult {
  const errors: string[] = [];
  const nodeIds = new Set(doc.nodes.map((n) => n.id));

  errors.push(...duplicateIdErrors(doc));

  for (const edge of doc.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(
        `Edge ${edge.id} references missing source node '${edge.source}'`,
      );
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(
        `Edge ${edge.id} references missing target node '${edge.target}'`,
      );
    }
  }

  const inputCount = doc.nodes.filter((n) => n.type === "input").length;
  if (inputCount !== 1) {
    errors.push(
      `Graph must contain exactly one Input node (found ${inputCount})`,
    );
  }

  const outputCount = doc.nodes.filter((n) => n.type === "output").length;
  if (outputCount !== 1) {
    errors.push(
      `Graph must contain exactly one Output node (found ${outputCount})`,
    );
  }

  const name = doc.workflow.name ?? "";
  // The slug, not the name: lowercasing can make a character usable (see `rawSlug`).
  if (rawSlug(name) === "") {
    errors.push(
      `Workflow name must contain at least one letter or digit usable in a file name ("${name}" produces an empty name)`,
    );
  }
  // The slug, not the name: they are not the same length (see MAX_BUNDLE_DIR_LENGTH).
  const dirLength = BUNDLE_DIR_PREFIX.length + slugify(name).length;
  if (dirLength > MAX_BUNDLE_DIR_LENGTH) {
    errors.push(
      `Workflow name is too long to export: it becomes the bundle directory '${BUNDLE_DIR_PREFIX}<slug>', which is also the name Claude Code discovers the exported skill by (and the namespace of anything bundled with it), so it must be at most ${MAX_BUNDLE_DIR_LENGTH} characters — this name produces ${dirLength}. Shorten it (up to ${MAX_WORKFLOW_NAME_LENGTH} characters is always safe).`,
    );
  }

  if (!doc.workflow.description || doc.workflow.description.trim() === "") {
    errors.push(
      "Workflow must have a description (used as the skill's description so Claude Code can discover it)",
    );
  }

  errors.push(...contentErrors(doc));
  errors.push(...linearityErrors(doc, nodeIds));

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Reject duplicate node/edge ids that would silently collapse or drop data. */
function duplicateIdErrors(doc: PatchworkDocument): string[] {
  const errors: string[] = [];
  const seenNodes = new Set<string>();
  for (const node of doc.nodes) {
    if (seenNodes.has(node.id)) errors.push(`Duplicate node id '${node.id}'`);
    else seenNodes.add(node.id);
  }
  const seenEdges = new Set<string>();
  for (const edge of doc.edges) {
    if (seenEdges.has(edge.id)) errors.push(`Duplicate edge id '${edge.id}'`);
    else seenEdges.add(edge.id);
  }
  return errors;
}

// Parameter names appear in an inline code span and are referenced in prompts,
// so constrain them to a safe charset (removes the code-span backtick hazard).
const PARAM_NAME_PATTERN = /^[\p{L}\p{N}_\- ]+$/u;

/** Reject empty/blank node field content that would export a non-compliant skill. */
function contentErrors(doc: PatchworkDocument): string[] {
  const errors: string[] = [];
  for (const node of doc.nodes) {
    if (node.type === "input") {
      const params = (node.data as InputData).parameters;
      if (!Array.isArray(params) || params.length === 0) {
        errors.push(`Input node '${node.id}' must declare at least one parameter`);
        continue;
      }
      for (const param of params) {
        const paramName = (param.name ?? "").trim();
        if (paramName === "") {
          errors.push(`Input node '${node.id}' has a parameter with an empty name`);
        } else if (!PARAM_NAME_PATTERN.test(paramName)) {
          errors.push(
            `Input node '${node.id}' has parameter '${param.name}' with invalid characters (use letters, digits, spaces, hyphens, or underscores)`,
          );
        }
      }
    } else if (node.type === "prompt") {
      if (((node.data as PromptData).instruction ?? "").trim() === "") {
        errors.push(`Prompt node '${node.id}' has an empty instruction`);
      }
    } else if (node.type === "output") {
      if (((node.data as OutputData).description ?? "").trim() === "") {
        errors.push(`Output node '${node.id}' has an empty description`);
      }
    } else if (artifactKindOf(node.type)) {
      errors.push(...artifactRefErrors(node));
    }
  }
  return errors;
}

/** Reject a `skill`/`agent` node that is not bound to a usable artifact. */
function artifactRefErrors(node: GraphNode): string[] {
  const errors: string[] = [];
  const label = node.type === "skill" ? "Skill" : "Agent";
  const ref = node.data as ArtifactRefData;
  const name = (ref.name ?? "").trim();

  if (name === "") {
    errors.push(
      `${label} node '${node.id}' is not bound to an artifact yet (pick one from a source root)`,
    );
  } else if (!isValidArtifactName(name)) {
    // The name is rendered into an inline code span in the umbrella skill.
    errors.push(
      `${label} node '${node.id}' references '${ref.name}', which is not a usable artifact name`,
    );
  }
  if ((ref.rootId ?? "").trim() === "") {
    errors.push(
      `${label} node '${node.id}' is missing the source root its artifact came from`,
    );
  }
  return errors;
}

/**
 * Enforce that the graph is a single simple chain Input -> ... -> Output.
 * Slice 1 is linear-only: no branching, no merging, no orphans, no cycles.
 */
function linearityErrors(
  doc: PatchworkDocument,
  nodeIds: Set<string>,
): string[] {
  const errors: string[] = [];
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const edge of doc.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    outDeg.set(edge.source, (outDeg.get(edge.source) ?? 0) + 1);
    inDeg.set(edge.target, (inDeg.get(edge.target) ?? 0) + 1);
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }

  for (const node of doc.nodes) {
    const out = outDeg.get(node.id) ?? 0;
    const inc = inDeg.get(node.id) ?? 0;
    if (inc > 1) {
      errors.push(
        `Node '${node.id}' has ${inc} incoming edges; slice 1 supports only a linear chain`,
      );
    }
    if (out > 1) {
      errors.push(
        `Node '${node.id}' has ${out} outgoing edges; slice 1 supports only a linear chain`,
      );
    }
    if (node.type === "input" && inc > 0) {
      errors.push(`Input node '${node.id}' must not have incoming edges`);
    }
    if (node.type === "output" && out > 0) {
      errors.push(`Output node '${node.id}' must not have outgoing edges`);
    }
  }

  // Cycle + connectivity are only well-defined with a single entry point.
  const inputs = doc.nodes.filter((n) => n.type === "input");
  if (inputs.length !== 1 || doc.nodes.length === 0) return errors;

  // Iterative DFS (explicit stack) so arbitrarily deep chains never overflow
  // the call stack — validateGraph must return errors, never throw.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const visited = new Set<string>();
  let cycleNode: string | null = null;

  const start = inputs[0].id;
  const frames: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
  color.set(start, GRAY);
  visited.add(start);

  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const neighbors = adjacency.get(frame.id) ?? [];
    if (frame.next < neighbors.length) {
      const nextId = neighbors[frame.next];
      frame.next += 1;
      const state = color.get(nextId) ?? WHITE;
      if (state === GRAY) {
        cycleNode = nextId;
        break;
      }
      if (state === WHITE) {
        color.set(nextId, GRAY);
        visited.add(nextId);
        frames.push({ id: nextId, next: 0 });
      }
    } else {
      color.set(frame.id, BLACK);
      frames.pop();
    }
  }

  if (cycleNode) {
    errors.push(`Graph contains a cycle through '${cycleNode}'`);
  } else {
    for (const node of doc.nodes) {
      if (!visited.has(node.id)) {
        errors.push(`Node '${node.id}' is not connected to the workflow`);
      }
    }
  }

  return errors;
}

/** Serialize a document to pretty-printed JSON for the `.patchwork` file. */
export function serialize(doc: PatchworkDocument): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse a `.patchwork` file back into a document.
 *
 * Rejects, with an actionable error, anything that is not a current-version
 * Patchwork document: arbitrary JSON, raw React Flow dumps, unknown/future
 * schema versions, or structurally malformed documents. This keeps malformed
 * input from crashing downstream consumers (compile / canvas adapter).
 */
export function deserialize(json: string): PatchworkDocument {
  const parsed = JSON.parse(json) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("File is not a Patchwork document (expected a JSON object)");
  }

  const doc = parsed as Record<string, unknown>;

  if (typeof doc.schemaVersion !== "number") {
    throw new Error(
      "File is not a Patchwork document (missing numeric 'schemaVersion' field)",
    );
  }
  if (
    doc.schemaVersion < MIN_SUPPORTED_SCHEMA_VERSION ||
    doc.schemaVersion > CURRENT_SCHEMA_VERSION ||
    !Number.isInteger(doc.schemaVersion)
  ) {
    throw new Error(
      `Unsupported schemaVersion ${doc.schemaVersion} (expected ${MIN_SUPPORTED_SCHEMA_VERSION}-${CURRENT_SCHEMA_VERSION}). This file was created by a different version of Patchwork.`,
    );
  }

  if (
    typeof doc.workflow !== "object" ||
    doc.workflow === null ||
    typeof (doc.workflow as { name?: unknown }).name !== "string"
  ) {
    throw new Error(
      "Malformed Patchwork document: 'workflow' must be an object with a 'name'",
    );
  }
  // Every free-text field is validated, not just the required ones: downstream
  // consumers call string methods on them (`validateGraph` trims the workflow
  // description, `compile` sanitizes parameter descriptions), and a wrong type
  // there surfaces as a TypeError far from the file that caused it.
  assertOptionalText(
    (doc.workflow as { description?: unknown }).description,
    "Workflow 'description'",
  );
  if (!Array.isArray(doc.nodes)) {
    throw new Error("Malformed Patchwork document: 'nodes' must be an array");
  }
  if (!Array.isArray(doc.edges)) {
    throw new Error("Malformed Patchwork document: 'edges' must be an array");
  }

  doc.nodes.forEach(assertNodeShape);
  doc.edges.forEach(assertEdgeShape);

  return migrateToCurrent(doc as unknown as PatchworkDocument);
}

/**
 * Forward migrations, keyed by the version they migrate *from*. Each step
 * upgrades a document by exactly one version, so a v1 file walks the whole
 * chain to the current version. Old files must keep opening — a migration may
 * never throw away data it does not understand.
 *
 * **Shape validation runs before migration**, against the *current* `NODE_TYPES`
 * and per-type `data` contracts. That holds only while every supported version's
 * node shapes are also valid under today's contracts — true for v1 -> v2, which
 * added node types without changing a field, and still true for v2 -> v3, which
 * adds `exportMode`: `assertNodeShape` accepts its *absence* (a v2 artifact
 * reference is a valid v3 one) and only rejects a present-but-unknown value. The
 * first migration that *renames or retypes* a node's `data`, or retires a node
 * type, would therefore see its input rejected by validation before it could ever
 * run: adding such a step means moving `assertNodeShape`/`assertEdgeShape` after
 * `migrateToCurrent` (and hardening the migrations themselves against malformed
 * input, which validation currently spares them).
 */
const MIGRATIONS: Record<number, (doc: PatchworkDocument) => PatchworkDocument> = {
  // v1 -> v2: `skill`/`agent` nodes were added to the palette. No existing
  // field changed shape, so a v1 document is already a valid v2 document.
  1: (doc) => ({ ...doc, schemaVersion: 2 }),
  // v2 -> v3: artifact references gained `exportMode`. Written out explicitly
  // rather than left to `exportModeOf`'s default so that re-saving an opened v2
  // document records the choice the user has been getting all along.
  2: (doc) => ({
    ...doc,
    schemaVersion: 3,
    nodes: doc.nodes.map((node) =>
      artifactKindOf(node.type)
        ? {
            ...node,
            data: {
              ...(node.data as ArtifactRefData),
              exportMode: exportModeOf(node.data as ArtifactRefData),
            },
          }
        : node,
    ),
  }),
};

function migrateToCurrent(doc: PatchworkDocument): PatchworkDocument {
  let migrated = doc;
  while (migrated.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const step = MIGRATIONS[migrated.schemaVersion];
    if (!step) {
      throw new Error(
        `No migration available from schemaVersion ${migrated.schemaVersion} to ${CURRENT_SCHEMA_VERSION}`,
      );
    }
    migrated = step(migrated);
  }
  return migrated;
}

/** Reject a node whose `type`/`data` shape would crash the canvas or compiler. */
function assertNodeShape(raw: unknown, index: number): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `Malformed Patchwork document: node at index ${index} is not an object`,
    );
  }
  const node = raw as Record<string, unknown>;
  const id = typeof node.id === "string" ? node.id : `#${index}`;

  if (typeof node.id !== "string") {
    throw new Error(
      `Malformed Patchwork document: node at index ${index} is missing a string 'id'`,
    );
  }
  if (typeof node.type !== "string" || !NODE_TYPES.includes(node.type as NodeType)) {
    throw new Error(
      `Node '${id}' has invalid type '${String(node.type)}' (expected one of ${NODE_TYPES.join(", ")})`,
    );
  }
  // `label` is rendered as a React child and `position` is handed to the canvas,
  // so a wrong type here would throw during render — past validation, where the
  // error boundary can only offer to discard the whole session.
  if (typeof node.label !== "string") {
    throw new Error(
      `Node '${id}' must have a string 'label' (found ${describeType(node.label)})`,
    );
  }
  if (node.position !== undefined) {
    const position = node.position as Record<string, unknown> | null;
    if (
      typeof position !== "object" ||
      position === null ||
      !Number.isFinite(position.x as number) ||
      !Number.isFinite(position.y as number)
    ) {
      throw new Error(
        `Node '${id}' has an invalid 'position' (expected {x, y} numbers, found ${describeType(node.position)})`,
      );
    }
  }
  if (typeof node.data !== "object" || node.data === null) {
    throw new Error(`Node '${id}' is missing its 'data' object`);
  }

  const data = node.data as Record<string, unknown>;
  switch (node.type as NodeType) {
    case "input": {
      if (!Array.isArray(data.parameters)) {
        throw new Error(`Input node '${id}' must have a 'parameters' array`);
      }
      data.parameters.forEach((param, i) => {
        if (
          typeof param !== "object" ||
          param === null ||
          typeof (param as Record<string, unknown>).name !== "string"
        ) {
          throw new Error(
            `Input node '${id}' parameter ${i} must have a string 'name'`,
          );
        }
        assertOptionalText(
          (param as Record<string, unknown>).description,
          `Input node '${id}' parameter ${i} 'description'`,
        );
      });
      break;
    }
    case "prompt":
      if (typeof data.instruction !== "string") {
        throw new Error(`Prompt node '${id}' must have a string 'instruction'`);
      }
      break;
    case "output":
      if (typeof data.description !== "string") {
        throw new Error(`Output node '${id}' must have a string 'description'`);
      }
      break;
    case "skill":
    case "agent": {
      const label = node.type === "skill" ? "Skill" : "Agent";
      if (typeof data.name !== "string") {
        throw new Error(
          `${label} node '${id}' must have a string 'name' naming the referenced artifact`,
        );
      }
      if (typeof data.rootId !== "string") {
        throw new Error(
          `${label} node '${id}' must have a string 'rootId' pointing at a configured source root`,
        );
      }
      // Absent is fine — that is a v2 reference, and `exportModeOf` reads it as
      // reference-by-name. An unknown value is not: silently treating it as one
      // of the two modes would decide, on the user's behalf, whether someone
      // else's file gets copied into their bundle.
      if (
        data.exportMode !== undefined &&
        !EXPORT_MODES.includes(data.exportMode as ExportMode)
      ) {
        throw new Error(
          `${label} node '${id}' has an invalid 'exportMode' '${String(data.exportMode)}' (expected one of ${EXPORT_MODES.join(", ")})`,
        );
      }
      break;
    }
  }
}

/**
 * Require an optional free-text field to be a string when present.
 *
 * Absent and empty are fine (validation decides whether they are acceptable);
 * a number, object, or array is not, because something downstream will treat it
 * as a string.
 */
function assertOptionalText(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(
      `Malformed Patchwork document: ${label} must be a string when present (found ${describeType(value)})`,
    );
  }
}

/** A short, safe description of an unexpected value's type for error messages. */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** Reject an edge missing the string endpoints the canvas adapter relies on. */
function assertEdgeShape(raw: unknown, index: number): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `Malformed Patchwork document: edge at index ${index} is not an object`,
    );
  }
  const edge = raw as Record<string, unknown>;
  for (const field of ["id", "source", "target"] as const) {
    if (typeof edge[field] !== "string") {
      throw new Error(
        `Malformed Patchwork document: edge at index ${index} is missing a string '${field}'`,
      );
    }
  }
}
