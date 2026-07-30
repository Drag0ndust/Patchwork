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
// The plan is how a document is *followed*, and both halves of the project need
// it: the compiler emits it, and validation asks it whether the graph can be
// followed at all. `workflow-order` depends on this module for types only, so the
// two never touch each other's bindings while either is still evaluating.
import { nestingDepth, planWorkflow } from "./workflow-order";

/**
 * Bumped to 4 in slice 4: the `conditional` node type, whose labelled branches
 * let the workflow fan out, and the `branch` field an edge leaving one carries.
 * (3 recorded, per `skill`/`agent` node, *how* it is exported — referenced by
 * name, or vendor-copied into the bundle.) `deserialize` migrates older
 * documents forward.
 */
export const CURRENT_SCHEMA_VERSION = 4;

/** The oldest document version that still opens (via forward migration). */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

export type NodeType =
  | "input"
  | "prompt"
  | "output"
  | "skill"
  | "agent"
  | "conditional";

const NODE_TYPES: NodeType[] = [
  "input",
  "prompt",
  "output",
  "skill",
  "agent",
  "conditional",
];

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

/**
 * How a `conditional` node decides which branch runs.
 *
 * Only `llm` exists in this slice: the umbrella states the decision question and
 * the branches, and the executing model picks one at runtime. The field is here
 * from the start so the rule-based mode of the next slice is an added variant
 * rather than a second schema — a document is read by asking
 * [`conditionalModeOf`], never by testing for a field's absence.
 */
export type ConditionalMode = "llm";

const CONDITIONAL_MODES: ConditionalMode[] = ["llm"];

/**
 * LLM-based branching is the default (and, today, the only mode), so a
 * hand-written or future-migrated document that omits the field is an LLM
 * conditional rather than an unreadable one.
 */
export const DEFAULT_CONDITIONAL_MODE: ConditionalMode = "llm";

/**
 * One labelled way out of a `conditional` node.
 *
 * The `id` is what an edge attaches to and the `label` is what the umbrella's
 * prose (and the canvas) show, deliberately kept apart: renaming a branch is an
 * ordinary edit, and if edges were keyed by the label every rename would either
 * orphan the wiring or need a cascade through the edge list. See ADR-0003.
 */
export interface Branch {
  id: string;
  label: string;
}

export interface ConditionalData {
  /** Optional on the *type* only — read it through [`conditionalModeOf`]. */
  mode?: ConditionalMode;
  /** What the executing model has to decide, in the user's own words. */
  question: string;
  branches: Branch[];
}

/** The branching mode a conditional node's stored data asks for. */
export function conditionalModeOf(data: ConditionalData): ConditionalMode {
  return data.mode ?? DEFAULT_CONDITIONAL_MODE;
}

/**
 * The branches a node offers — empty for anything that is not a conditional.
 *
 * Tolerant of a missing or non-array `branches` field, because the canvas and the compiler both
 * ask this of a document that may not have come through `deserialize`. The tolerance stops at the
 * field: an *entry* that is not a `{id, label}` object is `assertNodeShape`'s to reject, and this
 * function hands it back as it found it. Every caller therefore reads an entry with `?.` — that is
 * the contract, and it is what keeps "nothing here throws" true in `workflow-order`.
 */
export function branchesOf(node: GraphNode): Branch[] {
  if (node.type !== "conditional") return [];
  const branches = (node.data as ConditionalData).branches;
  return Array.isArray(branches) ? branches : [];
}

export type NodeData =
  | InputData
  | PromptData
  | OutputData
  | ArtifactRefData
  | ConditionalData;

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
  /**
   * The [`Branch.id`] this edge leaves its source node by — present exactly on
   * the edges of a `conditional` node.
   *
   * The branch lives on the *edge* rather than being implied by a port on the
   * node, because the edge is the thing the user draws and the thing the
   * compiler follows; see ADR-0003. The canvas realizes it as a per-branch
   * source handle, which is a rendering of this field, not a second source of
   * truth.
   */
  branch?: string;
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
  errors.push(...branchWiringErrors(doc, nodeIds));

  // Checked here, ahead of the plan, because everything below is a function of the size and
  // the plan is the most expensive of them. See [`MAX_WORKFLOW_NODES`].
  const tooLarge = doc.nodes.length > MAX_WORKFLOW_NODES;
  if (tooLarge) {
    errors.push(
      `This workflow has ${doc.nodes.length} nodes; at most ${MAX_WORKFLOW_NODES} can be compiled into one skill. Split it into workflows that call each other.`,
    );
  }

  const structure = structureErrors(doc, nodeIds);
  errors.push(...structure.errors);
  // The plan is what `compile` walks, so asking it is how "this graph can be
  // followed" is checked once rather than re-derived here — but only for an
  // acyclic graph: every node on a cycle is reached more than once, and burying
  // the cause under a list of its symptoms is not an actionable error list.
  // An over-large document is not planned at all: the plan is what the size bound exists to
  // avoid paying for, and "too many nodes" is a more actionable single reason to fix than
  // itself plus whatever a 20,000-node walk has to say about nesting.
  if (structure.walkable && !tooLarge) {
    const plan = planWorkflow(doc);
    errors.push(...plan.problems);
    const depth = nestingDepth(plan);
    if (depth > MAX_BRANCH_NESTING_DEPTH) {
      errors.push(
        `Conditionals are nested ${depth} levels deep; at most ${MAX_BRANCH_NESTING_DEPTH} levels can be written as instructions a reader could follow. Converge some branches before opening the next one.`,
      );
    }
  }

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

/**
 * Branch labels land in the same place parameter names do — an inline code span
 * in the umbrella — so they share the charset rather than inventing a second one.
 * On top of the code-span hazard, a label is what the executing model is asked to
 * name back when it picks a branch, and prose is a poor place for punctuation that
 * could read as markup.
 */
const BRANCH_LABEL_PATTERN = PARAM_NAME_PATTERN;

/**
 * How long a branch label may be.
 *
 * Borrowed from the one length convention the project already has for a
 * user-supplied string that has to be quoted verbatim elsewhere (the artifact name
 * segment) instead of inventing a second number. A label is a choice an LLM must
 * repeat exactly; a paragraph is not a choice.
 */
export const MAX_BRANCH_LABEL_LENGTH = MAX_NAME_SEGMENT_LENGTH;

/**
 * How deeply conditionals may nest — a conditional inside a branch of another is
 * depth 2.
 *
 * Bounded because *both* costs of nesting grow faster than the graph does. The emitted
 * umbrella indents every line of a branch one level further, so its size grows with the
 * square of the depth: 5,000 nested levels produced a **63 MB** `SKILL.md`, which the
 * renderer builds on its main thread and then hands to the emitter. And the reader — a
 * model following prose — has to hold one open choice per level, of which there are
 * 2^depth combinations; nobody follows 5,000, and nobody draws 32 either.
 *
 * 32 is therefore deliberately far above any workflow a person composes: it exists to
 * keep a generated or hand-edited document from turning an export into a freeze, not to
 * shape how anyone designs. A workflow that needs more nesting wants a branch that
 * converges (or a second workflow), which is the advice the error gives.
 */
export const MAX_BRANCH_NESTING_DEPTH = 32;

/**
 * How many nodes one workflow may compile into.
 *
 * Every later cost is a function of this number, and each of them is paid on the renderer’s
 * main thread: the plan, the reachability closure the plan builds (`n²/8` bytes), the
 * umbrella’s own size, and the IPC that carries the bundle to the emitter. 8,192 keeps all
 * of them comfortable — the closure is 8 MB, well inside the ceiling past which the plan
 * falls back to sweeping reachability quadratically, and the umbrella is a few hundred
 * kilobytes — while being far more steps than a workflow a person composes on a canvas, or
 * than a model could follow in one skill.
 *
 * It is checked **before** the document is planned, which is the point of having it: a
 * 20,002-node document used to take 22.8 s to validate and 21.9 s to compile before anything
 * refused it, and the refusal is now what reading the document costs. On its own it bounds
 * only *depth-wise* size; the **edge** count is bounded together with
 * [`MAX_BRANCHES_PER_CONDITIONAL`], since an accepted document has at most one outgoing edge
 * per non-conditional node and at most that many per conditional.
 */
export const MAX_WORKFLOW_NODES = 8192;

/**
 * How many branches one conditional may offer.
 *
 * A branch is a choice, and a choice is made by *reading the alternatives*: the umbrella
 * lists every branch of a branch point as its own bullet, and the executing model has to
 * pick one and name it back. That stops being a decision long before 64 alternatives, in
 * exactly the way a 64-character label stops being a label — which is where this number
 * comes from, rather than from a measurement.
 *
 * It is also the only bound on **width**, and three costs run off it. The canvas draws one
 * source handle per branch, and a document with 20,000 of them froze a real browser for
 * 10.8 s *on load*, before validation could refuse anything — which is why what the canvas
 * *draws* is bounded by this number (see `ConditionalNode` and `drawableEdges`), and why the
 * dock editor stops offering another branch at the limit. The load boundary itself
 * deliberately does **not** bound it: `deserialize` keeps every branch so an over-wide
 * document still opens, flagged and repairable, rather than becoming unopenable — see
 * ADR-0003 and the note in [`assertNodeShape`]. The umbrella grows a bullet and a
 * sub-list per branch. And it completes the bound on the **edge** count that
 * [`MAX_WORKFLOW_NODES`] could not give on its own: an accepted document has at most one
 * outgoing edge per non-conditional node and at most this many per conditional, so every
 * later cost that is linear in edges is now bounded by the two caps together.
 */
export const MAX_BRANCHES_PER_CONDITIONAL = 64;

/**
 * The fewest branches a conditional can offer and still be a choice.
 *
 * Named beside the ceiling because both bounds are enforced *and stated* in the same two
 * places — the dock editor, which says which bound a disabled control has reached, and
 * `validateGraph`, which refuses the export.
 */
export const MIN_BRANCHES_PER_CONDITIONAL = 2;

/**
 * The branches every surface shows when a node holds more than the limit.
 *
 * One definition, because three places need the answer and none of them may disagree: the canvas
 * node draws a source handle per branch, the dock lists a row per branch, and `drawableEdges`
 * hides the edges of the branches the node did not draw. They each used to slice the list
 * themselves. They agreed — but a drift in any one of them would have produced handles whose
 * edges were filtered away, or dock rows the canvas does not show, with nothing failing.
 *
 * The *first* N, deliberately: they are the branches the user sees first in the file, in the dock
 * and on the node, and the dock's repair button removes exactly the rest.
 */
export function branchesWithinLimit(branches: readonly Branch[]): Branch[] {
  return branches.length > MAX_BRANCHES_PER_CONDITIONAL
    ? branches.slice(0, MAX_BRANCHES_PER_CONDITIONAL)
    : (branches as Branch[]);
}

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
    } else if (node.type === "conditional") {
      errors.push(...conditionalErrors(node));
    } else if (artifactKindOf(node.type)) {
      errors.push(...artifactRefErrors(node));
    }
  }
  return errors;
}

/**
 * Reject a conditional whose branches an executing model could not act on.
 *
 * Every rule here is about the *prose the compiler will emit*: the model is told the
 * question and then asked to name one branch back, so a missing question, a single
 * branch, a blank or unquotable label, and two labels it could not tell apart each
 * leave an instruction that cannot be followed. The ids are checked for the canvas's
 * sake instead — they are what an edge attaches by.
 *
 * The **question** is bounded only by being non-blank, deliberately: it is prose, like a
 * `Prompt` node's instruction and the workflow description, and none of those carry a
 * charset or a length rule. A question is written in whatever language and punctuation
 * the decision needs ("Is the diff > 100 lines?"), and the compiler renders prose
 * losslessly through `sanitizeInline`, which neutralizes block structure without
 * rewriting characters. A branch **label** is the opposite kind of string — an
 * identifier the model has to quote back inside a code span — which is why it, and only
 * it, is constrained.
 */
function conditionalErrors(node: GraphNode): string[] {
  const errors: string[] = [];
  const data = node.data as ConditionalData;

  if ((data.question ?? "").trim() === "") {
    errors.push(
      `Conditional node '${node.id}' has an empty decision question; the exported skill has nothing to decide from`,
    );
  }

  const branches = branchesOf(node);
  if (branches.length < MIN_BRANCHES_PER_CONDITIONAL) {
    errors.push(
      `Conditional node '${node.id}' must offer at least two branches to choose between (found ${branches.length})`,
    );
  }
  if (branches.length > MAX_BRANCHES_PER_CONDITIONAL) {
    errors.push(
      `Conditional node '${node.id}' offers ${branches.length} branches; at most ${MAX_BRANCHES_PER_CONDITIONAL} can be written as a choice a reader could make. Decide between fewer, or branch again inside a branch.`,
    );
  }

  const seenIds = new Set<string>();
  // Case-folded and trimmed, because the label is only ever compared *by a
  // reader*: `crash` and `Crash` are one choice in prose however distinct they are
  // as strings, and a branch nobody can pick unambiguously is worse than a
  // rejected document.
  const seenLabels = new Set<string>();
  for (const branch of branches) {
    const id = (branch?.id ?? "").trim();
    if (id === "") {
      errors.push(
        `Conditional node '${node.id}' has a branch with an empty id; an edge cannot be attached to it`,
      );
    } else if (seenIds.has(id)) {
      errors.push(`Conditional node '${node.id}' has two branches with the id '${id}'`);
    } else {
      seenIds.add(id);
    }

    const label = (branch?.label ?? "").trim();
    if (label === "") {
      errors.push(
        `Conditional node '${node.id}' has a branch with an empty label; a branch is chosen by its label`,
      );
      continue;
    }
    if (!BRANCH_LABEL_PATTERN.test(label)) {
      errors.push(
        `Conditional node '${node.id}' has branch label '${branch.label}' with invalid characters (use letters, digits, spaces, hyphens, or underscores)`,
      );
    }
    if (label.length > MAX_BRANCH_LABEL_LENGTH) {
      errors.push(
        `Conditional node '${node.id}' has a branch label of ${label.length} characters; a label is quoted back by the model choosing it, so it must be at most ${MAX_BRANCH_LABEL_LENGTH} characters`,
      );
    }
    const folded = label.toLowerCase();
    if (seenLabels.has(folded)) {
      errors.push(
        `Conditional node '${node.id}' has two branches labelled '${label}'; branch labels must be distinguishable in prose`,
      );
    } else {
      seenLabels.add(folded);
    }
  }

  return errors;
}

/**
 * Enforce the correspondence between a conditional's branches and its edges: each
 * declared branch is wired exactly once, every edge leaving a conditional names a
 * branch that exists, and no other edge carries one.
 *
 * An **unwired** branch is rejected rather than allowed as "a branch that just
 * continues": the umbrella would offer the model a choice with nothing to do and
 * nowhere to go afterwards, which is the one failure mode LLM branching cannot
 * recover from at runtime. A branch that should simply carry on is wired straight
 * to the node the other branches converge on, which says the same thing and is
 * visible on the canvas.
 */
function branchWiringErrors(
  doc: PatchworkDocument,
  nodeIds: Set<string>,
): string[] {
  const errors: string[] = [];
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  /**
   * The branch ids each conditional offers, built once per node.
   *
   * Asking `branchesOf(source).some(...)` per *edge* instead made this check
   * O(edges × branches), and a four-node document with 50,000 branches wired to one
   * next node satisfies every other rule: `validateGraph` took 9.8 s on it, and 67 s at
   * 200,000 branches, on the renderer's main thread and on the path the export button runs.
   * `compile` was linear the whole time, so the freeze was entirely in the cheap check.
   */
  const offered = new Map<string, Set<string>>();
  for (const node of doc.nodes) {
    if (node.type !== "conditional") continue;
    offered.set(node.id, new Set(branchesOf(node).map((branch) => branch?.id)));
  }
  /**
   * Edge count per branch, per conditional, so both 0 and 2 are reportable.
   *
   * A map of maps rather than one map keyed by `${node} ${branch}`: ids are arbitrary
   * strings in a hand-edited document, so a joined key with *any* delimiter collides —
   * node `n1` branch `x y` and node `n1 x` branch `y` produce the same key, which made
   * an unwired branch borrow another node's wiring and export a branch that leads
   * nowhere, and (the same collision the other way round) made two correctly wired
   * branches read as one branch wired twice. Nested maps cannot collide at all.
   */
  const wired = new Map<string, Map<string, number>>();
  const countWire = (nodeId: string, branchId: string) => {
    const branches = wired.get(nodeId) ?? new Map<string, number>();
    branches.set(branchId, (branches.get(branchId) ?? 0) + 1);
    wired.set(nodeId, branches);
  };
  const wireCount = (nodeId: string, branchId: string) =>
    wired.get(nodeId)?.get(branchId) ?? 0;

  for (const edge of doc.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const source = byId.get(edge.source) as GraphNode;
    const branch = edge.branch;

    if (source.type !== "conditional") {
      if (branch !== undefined && branch !== "") {
        errors.push(
          `Edge ${edge.id} carries branch '${branch}', but its source node '${source.id}' is not a Conditional node`,
        );
      }
      continue;
    }

    if (branch === undefined || branch === "") {
      errors.push(
        `Edge ${edge.id} leaves Conditional node '${source.id}' without a branch; connect it to one of the node's branch handles`,
      );
      continue;
    }
    if (offered.get(source.id)?.has(branch) !== true) {
      errors.push(
        `Edge ${edge.id} leaves Conditional node '${source.id}' on branch '${branch}', which that node does not offer`,
      );
      continue;
    }
    countWire(source.id, branch);
  }

  for (const node of doc.nodes) {
    for (const branch of branchesOf(node)) {
      const count = wireCount(node.id, branch?.id ?? "");
      // A branch whose own label/id is already reported as unusable is not also
      // reported as unwired: one broken branch, one error.
      if ((branch?.label ?? "").trim() === "" || (branch?.id ?? "").trim() === "")
        continue;
      if (count === 0) {
        errors.push(
          `Branch '${branch.label}' of Conditional node '${node.id}' is not wired to anything; every branch must lead somewhere`,
        );
      } else if (count > 1) {
        errors.push(
          `Branch '${branch.label}' of Conditional node '${node.id}' is wired to ${count} nodes; a branch is one path`,
        );
      }
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

/** Structural verdict: the errors found, and whether the plan check can run. */
interface StructureVerdict {
  errors: string[];
  /**
   * True when the graph is a single-entry acyclic graph, i.e. when following it is
   * a well-defined thing to do. Only then is the plan check in `validateGraph`
   * meaningful: without one Input there is nowhere to start, and with a cycle every
   * node on it is trivially "reached more than once".
   */
  walkable: boolean;
}

/**
 * Enforce that the graph runs from the one Input to the one Output with no orphans
 * and no cycles, and that it fans out only where a fan-out means something.
 *
 * Slice 1 was linear-only. Slice 4 relaxes exactly two things:
 *
 * - **Fan-out** is allowed at a `conditional` node and nowhere else; how many
 *   edges it has is governed by its branches (see [`branchWiringErrors`]).
 * - **Fan-in** is no longer checked at all, because it is now what re-convergence
 *   looks like — and it cannot occur *without* a conditional: with every other node
 *   limited to one outgoing edge, two edges into one node would need a second path
 *   out of some node, and the only way to reach a merge twice in a fan-out-free
 *   graph is a cycle, which is still rejected below. Whether the merge is a
 *   *legitimate* convergence point is decided by the plan check in `validateGraph`,
 *   which asks the same traversal the compiler walks.
 *
 * The "leads somewhere" rule is new and belongs to fan-out: in a chain, one Output
 * plus connectivity already forced every node to lead on, but a branch can now end
 * mid-air while every node is still reachable.
 */
function structureErrors(
  doc: PatchworkDocument,
  nodeIds: Set<string>,
): StructureVerdict {
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
    if (out > 1 && node.type !== "conditional") {
      errors.push(
        `Node '${node.id}' has ${out} outgoing edges; only a Conditional node may branch`,
      );
    }
    if (out === 0 && node.type !== "output") {
      errors.push(
        `Node '${node.id}' has no outgoing edge; every node except the Output node must lead somewhere`,
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
  if (inputs.length !== 1 || doc.nodes.length === 0) {
    return { errors, walkable: false };
  }

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

  return { errors, walkable: cycleNode === null };
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
 * reference is a valid v3 one) and only rejects a present-but-unknown value. It
 * remains true for v3 -> v4, which only *widens* the vocabulary — a node type and an
 * optional edge field that no older document uses — so nothing an older document
 * contains became invalid. The first migration that *renames or retypes* a node's
 * `data`, or retires a node type, would therefore see its input rejected by
 * validation before it could ever run: adding such a step means moving `assertNodeShape`/`assertEdgeShape` after
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
  // v3 -> v4: the `conditional` node type and an edge's `branch` field. Both are
  // *additions* to the vocabulary — no v3 document contains either, and none of its
  // fields changed shape — so a v3 document is already a valid v4 document, and the
  // migration only records the version it now opens at.
  3: (doc) => ({ ...doc, schemaVersion: 4 }),
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
    case "conditional": {
      if (typeof data.question !== "string") {
        throw new Error(
          `Conditional node '${id}' must have a string 'question' stating what to decide`,
        );
      }
      if (!Array.isArray(data.branches)) {
        throw new Error(`Conditional node '${id}' must have a 'branches' array`);
      }
      // Deliberately **no** bound on the branch count here, though `validateGraph` has one.
      // This function refuses what has no meaning on the canvas at all — a node type with no
      // renderer, a position that is not a pair of numbers — and a wide conditional is not
      // that: it is drawable, only slowly. Refusing it here made a file that used to open
      // unopenable, with no recovery inside the app, which is a worse outcome than the freeze
      // it prevented. What the canvas *draws* is bounded instead (`ConditionalNode`,
      // `drawableEdges`), the node is flagged the way an unresolved artifact reference is, and
      // the export is refused with a message naming the node. See ADR-0003.
      data.branches.forEach((branch, i) => {
        const fields = branch as Record<string, unknown> | null;
        if (
          typeof fields !== "object" ||
          fields === null ||
          typeof fields.id !== "string" ||
          typeof fields.label !== "string"
        ) {
          throw new Error(
            `Conditional node '${id}' branch ${i} must have a string 'id' and 'label'`,
          );
        }
      });
      // Absent is fine — that is what every document written before rule-based
      // conditionals exist means, and `conditionalModeOf` reads it as `llm`. An
      // unknown value is not: guessing a mode would decide, on the user's behalf,
      // *who* chooses the branch at runtime.
      if (
        data.mode !== undefined &&
        !CONDITIONAL_MODES.includes(data.mode as ConditionalMode)
      ) {
        throw new Error(
          `Conditional node '${id}' has an invalid 'mode' '${String(data.mode)}' (expected one of ${CONDITIONAL_MODES.join(", ")})`,
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
  // The branch an edge leaves its source by is validated for *type* only here;
  // whether the named branch exists is `validateGraph`'s business, because a
  // document may legitimately be opened while it is still being wired up.
  assertOptionalText(edge.branch, `edge at index ${index} 'branch'`);
}
