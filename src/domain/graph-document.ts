/**
 * The Graph Document: Patchwork's own persisted `.patchwork` schema.
 *
 * This is deliberately NOT React Flow's internal JSON. React Flow node
 * positions are kept under an optional `position` field for round-tripping the
 * canvas, but the document itself is the source of truth for compilation.
 */

import {
  artifactRelativePath,
  isValidArtifactName,
  isValidAuthoredArtifactName,
  MAX_NAME_SEGMENT_LENGTH,
  parseArtifactLocation,
  type ArtifactKind,
} from "./artifact-codec";
// The plan is how a document is *followed*, and both halves of the project need
// it: the compiler emits it, and validation asks it whether the graph can be
// followed at all. `workflow-order` depends on this module for types only, so the
// two never touch each other's bindings while either is still evaluating.
import { fanInInputs, nestingDepth, planWorkflow } from "./workflow-order";
import type { WorkflowPlan } from "./workflow-order";

/**
 * Bumped to 7 in slice 8: a `skill`/`agent` node's artifact can be **authored in
 * the graph** rather than imported from a source root — its frontmatter fields and
 * its Markdown body are carried in the document itself, which is what makes a
 * `.patchwork` file with a capability nobody has installed still shareable.
 *
 * **6 is not this slice's**, and the number is why this one is 7: two branches in
 * flight both called themselves 6 for unrelated formats, and a version number that no
 * longer identifies a format opens a document into an error about a field the reader
 * has never heard of. 6 belongs to the branch that landed first (a cycle's iteration
 * guard); this one takes the next number and migrates through it.
 *
 * (5 made a `conditional` rule-based and gave an edge its `inputLabel`; 4 added the
 * `conditional` node type and an edge's `branch`; 3 recorded, per `skill`/`agent`
 * node, *how* it is exported — referenced by name, or vendor-copied into the
 * bundle.) `deserialize` migrates older documents forward.
 */
export const CURRENT_SCHEMA_VERSION = 7;

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
 *
 * A node that was *switched back* from authoring also carries the authored fields
 * (`description`, `body`, `tools`, `model`, `effort`), and they are **present but
 * ignored**: every path reads an artifact node through [`artifactSourceOf`], so an
 * imported node's prose is never emitted and never reaches the umbrella. They are kept
 * rather than stripped so that flipping the source select back returns the body the
 * author wrote — losing it to a mis-click is a real loss, and the fields it would be
 * carried in are these ones. See [`asImported`] in the dock.
 *
 * The one authored field that is **not** carried is the `name`, in either direction.
 * This shape's `name` is the binding to an installed artifact — it is the field the
 * picker writes — so there is nowhere here to park an authored name, and an authored
 * node built from this one must not inherit it (that would author an artifact claiming
 * an installed one's name). Parking it in a second key instead would put a field in
 * every saved document whose only job is undoing a select, so an authored name typed
 * before a trip through `imported` is typed again on the way back; the dock says so at
 * once, because a nameless authored artifact is a problem it reports live. ADR-0007.
 */
export interface ArtifactRefData {
  name: string;
  rootId: string;
  /**
   * Where this node's artifact comes from. Optional on the *type* only, for the
   * reason `exportMode` is: every document written before slice 8 omits it, and
   * every path that needs the value goes through [`artifactSourceOf`].
   */
  source?: "imported";
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

/**
 * The export mode a `skill`/`agent` node's stored reference asks for.
 *
 * Total, for the reason [`asText`] is: `assertNodeShape` checks this field on an
 * *imported* node but deliberately leaves an authored node's carried copy of it
 * untyped, and the dock writes that copy back into the imported shape when the source
 * select is flipped. Anything that is not one of the two modes is the default — the
 * same answer absence gets — so a hand-edited file cannot travel through the dock and
 * come out as a document that will not open again (issue #27).
 */
export function exportModeOf(data: ArtifactRefData): ExportMode {
  return EXPORT_MODES.includes(data.exportMode as ExportMode)
    ? (data.exportMode as ExportMode)
    : DEFAULT_EXPORT_MODE;
}

/**
 * Where a `skill`/`agent` node's artifact comes from.
 *
 * - `imported` — it lives in one of the user's source roots and the node holds a
 *   symbolic reference to it (slices 2 and 3).
 * - `authored` — it was written **here**, in this graph, and the document carries
 *   its fields and its body. There is no file anywhere until the workflow is
 *   exported. See ADR-0007.
 */
export type ArtifactSource = "imported" | "authored";

const ARTIFACT_SOURCES: ArtifactSource[] = ["imported", "authored"];

/**
 * Importing is the default, because it is what every document written before this
 * slice means — a v6 artifact node has no `source` and is a reference to something
 * on disk, which is exactly what it was.
 */
export const DEFAULT_ARTIFACT_SOURCE: ArtifactSource = "imported";

/**
 * A `skill`/`agent` artifact **authored in the graph**.
 *
 * Stored as *fields plus a body* rather than as file text: the frontmatter is
 * derived at emit time by the Artifact Codec (`composeArtifact`), so what the form
 * collects is the artifact and the emitted YAML is valid by construction. The
 * reverse — keeping the file text and parsing it back — is what an *imported*
 * artifact does, because there the bytes are the user's and must survive untouched.
 *
 * `name` is optional, and it is the one asymmetry between the two kinds: an agent
 * *is* the file `agents/<name>.md` and nothing else names it, while a skill is a
 * directory Patchwork mints and the graph already has a name for it — the node's
 * own label. Both kinds *carry* one, though, and for a skill it is the way out of a
 * label that has nothing a file name can be built from — which is every label written
 * in a script that is not Latin. See [`authoredArtifactName`] and ADR-0007.
 */
export interface AuthoredArtifactData {
  source: "authored";
  name?: string;
  description: string;
  /** The curated Advanced frontmatter surface; blank entries are never emitted. */
  tools?: string;
  model?: string;
  effort?: string;
  /** The Markdown below the frontmatter, seeded from a type-specific scaffold. */
  body: string;
}

/** A `skill`/`agent` node's data, whichever way its artifact came to be. */
export type ArtifactNodeData = ArtifactRefData | AuthoredArtifactData;

/** Where a `skill`/`agent` node's stored data says its artifact comes from. */
export function artifactSourceOf(data: ArtifactNodeData): ArtifactSource {
  return data.source ?? DEFAULT_ARTIFACT_SOURCE;
}

/**
 * The artifact a node authored, or `undefined` for anything else — an imported
 * reference, a node of another type, or data a hand-edited document made nonsense of.
 *
 * Tolerant by design, like [`branchesOf`]: the canvas, the dock and the compiler all
 * ask this of node data that may never have been through `deserialize`, and every one
 * of them must degrade rather than throw (issue #27).
 */
export function authoredArtifactOf(node: GraphNode): AuthoredArtifactData | undefined {
  if (!artifactKindOf(node.type)) return undefined;
  const data = node.data as AuthoredArtifactData | undefined;
  if (data === undefined || data === null || typeof data !== "object") return undefined;
  return data.source === "authored" ? data : undefined;
}

/**
 * A free-text field of in-memory node data, read as the text it is meant to be.
 *
 * Every field this module and the codec treat as prose is reached through here, for
 * the reason [`authoredArtifactOf`] is tolerant: the canvas, the dock and the compiler
 * all ask these questions of node data that never went through `deserialize`, and a
 * number where a description belongs owes the user an error list rather than a
 * TypeError (issue #27). A value that is not text is a field with nothing in it, which
 * is exactly what the required-field errors below already say.
 */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * What an authored artifact is called — the name it is invoked by, and the name its
 * location inside the bundle has to yield back.
 *
 * A skill with no name of its own is named by **the node's label**, slugged the way
 * the workflow name is slugged into the bundle directory. That is not a convenience:
 * an artifact's identity normally comes from its location on disk (ADR-0001) and an
 * authored one has no location yet, so its identity has to come from the only place
 * left — the graph. The node's label is what the graph already calls it, and it is
 * what a reader sees on the canvas.
 *
 * An **agent** gets no such fallback. It is a single file `agents/<name>.md`, so the
 * name is the file, and Patchwork inventing one from a label the author has not
 * revisited would put a file on disk under a name nobody chose. `validateGraph`
 * refuses an unnamed authored agent instead. See ADR-0007.
 */
export function authoredArtifactName(node: GraphNode): string {
  const authored = authoredArtifactOf(node);
  if (authored === undefined) return "";
  const declared = asText(authored.name).trim();
  if (declared !== "") return declared;
  // [`rawSlug`], **not** [`slugify`]: the fallback to the literal `"workflow"` belongs
  // to the bundle directory, which must be called something. Borrowing it here named
  // every skill whose label is not Latin script `workflow` — a Chinese or Greek
  // author's artifacts silently misnamed, and two of them colliding on a name nobody
  // typed. A label that produces nothing produces no name, and `authoredArtifactErrors`
  // asks for one.
  return node.type === "skill" ? rawSlug(asText(node.label)) : "";
}

/** An artifact that already exists where an authored one might be written. */
export interface InstalledArtifact {
  kind: ArtifactKind;
  name: string;
}

/**
 * Every problem with the authored artifacts in a graph, per node.
 *
 * **One rule, two surfaces.** `validateGraph` asks it of the document alone, and the
 * dock asks it of the same nodes plus the artifacts the import catalog resolved — so
 * what the editor says while you type and what the export refuses cannot drift apart,
 * the way the dock's operand check and the validator's already cannot.
 *
 * The difference the second argument makes is the whole of "collision-at-write":
 *
 * - a clash with **another authored node** is an error either way, because two
 *   authored artifacts with one name land on one path inside the bundle and only one
 *   file can exist there;
 * - a clash with an **installed** artifact is reported only where the catalog is
 *   known, because it is not an export problem at all — a bundle is its own namespace
 *   (ADR-0002) — but it is exactly what will bite when the artifact is promoted to a
 *   source root, and learning it then is too late.
 *
 * The third argument is the **bundle directory** the document compiles into, and it
 * carries the one authored-name rule that is not a property of the name alone: the
 * directory is the namespace, so it is `<bundleDir>:<name>` that Claude Code resolves,
 * and two segments that are each acceptable can still overrun the whole-name bound
 * together. Passed by both surfaces — the validator derives it from the workflow name
 * and the dock is handed the same one — because a check only one of them can run is
 * exactly the drift this function exists to prevent. Omitted, the bound is not
 * invented: a caller that does not know the directory does not know the answer.
 *
 * Never throws, for the reason `validateGraph` never does: it is asked of in-memory
 * node data that a hand edit may have made nonsense of.
 */
export function authoredArtifactErrors(
  nodes: readonly GraphNode[],
  installed: readonly InstalledArtifact[] = [],
  bundleDir = "",
): Map<string, string[]> {
  const problems = new Map<string, string[]>();
  const add = (id: string, message: string) => {
    const existing = problems.get(id);
    if (existing) existing.push(message);
    else problems.set(id, [message]);
  };

  // Case-folded, because the bundle is written to a **filesystem**: the default one
  // on macOS (APFS) and Windows (NTFS) treats `skills/triage/` and `skills/Triage/`
  // as one directory, so two names that differ only in case are one file.
  const claim = (kind: ArtifactKind, name: string) => `${kind} ${name.toLowerCase()}`;
  const installedNames = new Set(installed.map((a) => claim(a.kind, a.name)));

  /** The authored nodes claiming each name, so *both* sides of a clash are named. */
  const claimants = new Map<string, GraphNode[]>();
  const authoredNodes: Array<{ node: GraphNode; data: AuthoredArtifactData }> = [];
  for (const node of nodes) {
    const data = authoredArtifactOf(node);
    if (data === undefined) continue;
    authoredNodes.push({ node, data });
    const name = authoredArtifactName(node);
    if (name === "") continue;
    const key = claim(artifactKindOf(node.type) as ArtifactKind, name);
    claimants.set(key, [...(claimants.get(key) ?? []), node]);
  }

  for (const { node, data } of authoredNodes) {
    const kind = artifactKindOf(node.type) as ArtifactKind;
    const label = nodeLabelFor(kind);
    const noun = kind === "skill" ? "skill" : "agent";

    if (asText(data.description).trim() === "") {
      add(
        node.id,
        `${label} node '${node.id}' authors a ${noun} with no description; Claude Code uses the description to decide when to invoke it, so it cannot be left empty`,
      );
    }
    if (asText(data.body).trim() === "") {
      add(
        node.id,
        `${label} node '${node.id}' authors a ${noun} with an empty body; the body is what Claude Code follows when it is invoked`,
      );
    }

    const name = authoredArtifactName(node);
    const nameProblem = authoredNameProblem(node, kind, name, bundleDir);
    if (nameProblem !== undefined) {
      add(node.id, nameProblem);
      continue;
    }

    const key = claim(kind, name);
    const others = (claimants.get(key) ?? []).filter((other) => other.id !== node.id);
    if (others.length > 0) {
      add(
        node.id,
        `${label} node '${node.id}' authors a ${noun} called '${name}', and so does node '${others.map((o) => o.id).join("', '")}'; they would be written to one file, so rename one of them`,
      );
    }
    if (installedNames.has(key)) {
      add(
        node.id,
        `${label} node '${node.id}' authors a ${noun} called '${name}', and a ${noun} of that name is already in your source roots — the export is unaffected (the bundle is its own namespace), but writing this one to a root would collide with it`,
      );
    }
  }

  return problems;
}

/** `Skill`/`Agent`, the way every error in this module says it. */
function nodeLabelFor(kind: ArtifactKind): string {
  return kind === "skill" ? "Skill" : "Agent";
}

/**
 * Why this authored artifact could not be written under this name, or `undefined` when
 * it can.
 *
 * Every rule here is about **the name and where it lands**, and the four are one
 * function so that the dock cannot show a path the export would refuse: the same
 * predicate decides the error list and [`authoredArtifactPathOf`], which is the only
 * thing the dock is allowed to promise a path from. Ordered, and each one returns —
 * a name that is not usable at all has nothing to say about the path it would take.
 */
function authoredNameProblem(
  node: GraphNode,
  kind: ArtifactKind,
  name: string,
  bundleDir: string,
): string | undefined {
  const label = nodeLabelFor(kind);
  const noun = kind === "skill" ? "skill" : "agent";

  if (name === "") {
    // Two ways to have no name, and they are fixed differently. An agent never had a
    // fallback: nothing but the author names the file `agents/<name>.md`. A skill is
    // named by its node's label — but only when the label has something a file name
    // can be built out of, which `caché`, `中文` and `!!!` do not. Saying "no name"
    // to an author who *has* labelled the node is unactionable; the way out is the
    // explicit name the skill form also carries, so the message names it.
    return kind === "skill"
      ? `${label} node '${node.id}' authors a ${noun} named after its label, and '${asText(node.label).slice(0, MAX_NAME_SEGMENT_LENGTH)}' has no letters or digits a file name can be built from; give it a name of its own under Advanced`
      : `${label} node '${node.id}' authors a ${noun} with no name; an agent is the file 'agents/<name>.md', so nothing else says what it is called`;
  }
  if (!isValidAuthoredArtifactName(name)) {
    return `${label} node '${node.id}' would author '${name.slice(0, MAX_NAME_SEGMENT_LENGTH * 2)}', which is not a usable artifact name (letters, digits, '.', '_' or '-'; no ':' — the bundle is already the namespace; not a Windows device name such as 'CON' or 'NUL'; at most ${MAX_NAME_SEGMENT_LENGTH} characters)`;
  }

  // And the path has to name the artifact back. `artifactRelativePath` is not injective
  // in the other direction for every input: an agent named `SKILL` lands at
  // `agents/SKILL.md`, which the layout rule says is not an artifact at all — so the
  // file would sit in the bundle under a name nothing resolves. Asserting the round
  // trip closes that whole class instead of banning one name.
  const path = artifactRelativePath(kind, name);
  const located = parseArtifactLocation(path);
  if (located?.kind !== kind || located.name !== name) {
    return `${label} node '${node.id}' authors a ${noun} called '${name}', but a copy at '${path}' would not be discoverable as '${name}' — rename it`;
  }

  // The bundle directory is the artifact's namespace, and it is the *joined* name
  // Claude Code resolves: two segments that are each acceptable can still overrun the
  // whole-name bound together (a 64-character directory and a 64-character name make
  // 129). Only asked where the directory is known — see [`authoredArtifactErrors`].
  if (bundleDir !== "" && !isValidArtifactName(`${bundleDir}:${name}`)) {
    return `${label} node '${node.id}' authors a ${noun} called '${name}', but inside the bundle it would be invoked as '${bundleDir}:${name}', which is not a name Claude Code can resolve — shorten the workflow name, or give the ${noun} a shorter name`;
  }

  return undefined;
}

/**
 * Where this node's authored artifact would be written inside the bundle, or
 * `undefined` when it would not be written at all.
 *
 * The dock's "Exported as" line is this and nothing else. It used to re-derive the
 * path from the name-validity rule alone, which is a *weaker* test than the export's:
 * an agent named `SKILL`, or a name that overran the invocation bound, got a path
 * printed under it that no export would ever produce. One function answers both, so
 * the promise and the refusal are the same decision.
 */
export function authoredArtifactPathOf(
  node: GraphNode,
  bundleDir = "",
): string | undefined {
  const kind = artifactKindOf(node.type);
  if (!kind || authoredArtifactOf(node) === undefined) return undefined;
  const name = authoredArtifactName(node);
  if (authoredNameProblem(node, kind, name, bundleDir) !== undefined) return undefined;
  return artifactRelativePath(kind, name);
}

/**
 * How a `conditional` node decides which branch runs.
 *
 * - `llm` — the umbrella states the decision question and the branches, and the
 *   executing model picks one at run time. Best-effort by construction.
 * - `rule` — the node carries a [`ConditionalRule`], the exported control
 *   scaffold evaluates it, and the model follows the branch the scaffold names.
 *   Deterministic: the same measured value always routes the same way.
 *
 * A document is read by asking [`conditionalModeOf`], never by testing for a
 * field's absence, which is what made adding `rule` a widening rather than a
 * second schema (ADR-0003, decision 2).
 */
export type ConditionalMode = "llm" | "rule";

const CONDITIONAL_MODES: ConditionalMode[] = ["llm", "rule"];

/**
 * How a rule compares the value it is given against the value the author wrote.
 *
 * Deliberately small, and every one of them is something a POSIX shell can decide
 * without interpreting anything: three string comparisons and two integer ones.
 * A regular-expression operator was considered and left out — the scaffold would
 * have to carry a pattern language whose behaviour differs between `grep`
 * implementations, which is exactly the kind of "deterministic" that is not.
 */
export type RuleOperator =
  | "equals"
  | "not-equals"
  | "contains"
  | "greater-than"
  | "less-than";

const RULE_OPERATORS: RuleOperator[] = [
  "equals",
  "not-equals",
  "contains",
  "greater-than",
  "less-than",
];

/** The operators whose two sides must be whole numbers. */
export const NUMERIC_RULE_OPERATORS: RuleOperator[] = ["greater-than", "less-than"];

/**
 * The operand as it is actually compared — **the one place whitespace is decided**.
 *
 * `validateGraph` checks this string and the Graph Compiler emits this string, so the
 * scaffold cannot be handed an operand the validator never approved. That is not a tidiness
 * rule: the two used to normalize separately, and a numeric rule written as `" 5"` passed
 * validation, compiled to `operand=' 5'`, and then refused to route on every shell — a
 * document the app called exportable producing a bundle that could not take that branch.
 * A second spelling of "trim" is what made that possible, so there is exactly one.
 *
 * It is **operator-aware**, which is why it cannot simply be `trim()` at either end:
 *
 * - for a numeric comparison, padding is not part of a magnitude, so it goes. The shell
 *   would reject it as a non-digit, and a user typing a space is not asking for anything;
 * - for a string comparison, padding **is** the data. `contains " x "` looks for a spaced
 *   `x`, and trimming it would silently change what the workflow searches for.
 *
 * Emptiness is decided on the trimmed value either way (see `ruleErrors`): an operand of
 * nothing but whitespace is nothing to compare against, whichever comparison is asked for.
 */
export function comparedOperand(rule: ConditionalRule): string {
  const operand = rule.operand ?? "";
  if (!NUMERIC_RULE_OPERATORS.includes(rule.operator)) return operand;
  // Trimmed only where trimming is what makes the comparison possible. A numeric rule whose
  // operand is not a number compares *nothing* — `validateGraph` refuses it — so there is no
  // normalized form of it to speak of, and inventing one throws away what the user typed:
  // `contains " x "` switched to a numeric comparison and straight back came home as
  // `"x"`, because the intermediate state answered this question as though it had compared
  // something. Each switch looked correct on its own; the pair lost data. What has no
  // meaning is left exactly as it is.
  const trimmed = operand.trim();
  return isWholeNumber(trimmed) ? trimmed : operand;
}

/**
 * The rule after the user changes **which comparison it makes**.
 *
 * The operand is re-normalized to what was being compared *before* the change, which is
 * the one thing the user has actually seen. Without this, padding that a numeric
 * comparison ignored became data the moment the comparison became a string one: a rule
 * authored as `greater-than " 5"` (a space pasted in from a log line, harmless, validated,
 * routed correctly) turned into `equals " 5"` on a dropdown change alone — still valid,
 * still unwarned, rendering identically on the canvas because HTML collapses whitespace —
 * and then routed a measured `5` to the **false** branch at exit 0. A wrong branch with a
 * successful exit is the one failure the refusal contract cannot catch, in the mode whose
 * whole point is that the decision is not a judgement.
 *
 * So the invariant is: **the operand's effective meaning never changes unless the user
 * changes it.** Switching from a numeric comparison stores the trimmed value, because
 * trimmed is what was compared; switching from a string one stores it verbatim, for the
 * same reason. Where padding *is* semantic it is now also visible — see [`describeRule`]
 * and the dock's note.
 */
export function withOperator(
  rule: ConditionalRule,
  operator: RuleOperator,
): ConditionalRule {
  return { ...rule, operator, operand: comparedOperand(rule) };
}

/**
 * How each comparison is written where a rule is *shown* rather than evaluated.
 *
 * One definition, because two surfaces read it — the canvas node's summary and the dock
 * — and a user matching what the node says against what the dock offers must not be
 * looking at two vocabularies. The exported scaffold does not use it: there the operator
 * is a keyword a shell compares, not a phrase a person reads.
 */
export const RULE_OPERATOR_SYMBOLS: Record<RuleOperator, string> = {
  equals: "=",
  "not-equals": "≠",
  contains: "contains",
  "greater-than": ">",
  "less-than": "<",
};

/**
 * A rule as one line, for a canvas node that has room for one.
 *
 * It shows [`comparedOperand`] rather than the stored field — what is compared is what a
 * reader needs — and **quotes a string operand**, always. The quotes are not decoration:
 * a string comparison keeps its whitespace, this line is rendered as HTML, and HTML
 * collapses whitespace runs, so ` 5` and `5` (and `a  b` and `a b`) were the same pixels.
 * A rule whose meaning cannot be read off the canvas is a rule the author cannot check.
 *
 * Quoting *every* string operand rather than only a padded one also makes the two kinds of
 * comparison tell themselves apart at a glance, and means there is no threshold to get
 * subtly wrong. A numeric operand is never quoted: it has been trimmed to digits, so there
 * is nothing left to hide.
 */
export function describeRule(rule: ConditionalRule): string {
  const operand = comparedOperand(rule);
  // Bare only when there is provably nothing to hide: a numeric comparison whose operand is
  // the digits it compares. A numeric rule that kept its padding is one `validateGraph`
  // refuses *because* of the padding, so that is exactly when it has to be visible.
  const bare =
    NUMERIC_RULE_OPERATORS.includes(rule.operator) && operand === operand.trim();
  const shown = bare ? operand : `"${quoteOperand(operand)}"`;
  return `${rule.subject} ${RULE_OPERATOR_SYMBOLS[rule.operator] ?? rule.operator} ${shown}`.trim();
}

/**
 * An operand's own delimiters, escaped, so the quoted region has exactly one end.
 *
 * Without it `contains 'a"b'` summarised to `subject contains "a"b"`, which is three quotes
 * and no way to tell which of them closes the value — defeating the single thing the
 * quoting was added for. The backslash is escaped first, so the escape itself is
 * unambiguous: `a\b` reads as a literal backslash rather than as an escaped `b`.
 *
 * This is a *display* rule, and it is the whole extent of it — nothing here is parsed back,
 * and the string is React text output rather than markup, so there is no injection to
 * defend against. Only legibility, in the one line a canvas node has.
 */
function quoteOperand(operand: string): string {
  return operand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The default a freshly made rule starts from. */
export const DEFAULT_RULE_OPERATOR: RuleOperator = "equals";

/**
 * The deterministic check a rule-based `conditional` routes by.
 *
 * The split of labour is the point, and it is what "hybrid determinism" means
 * here (ADR-0004): the **model measures** the `subject` — it is the only party
 * that can read the work so far — and the **scaffold decides**, because a
 * comparison is the part that must not vary. So `subject` is prose (like a
 * `Prompt` instruction) while everything else is data a shell script evaluates.
 *
 * `whenTrue`/`whenFalse` are [`Branch.id`]s rather than positions, for the reason
 * an edge names a branch by id (ADR-0003): reordering or relabelling a branch is
 * an ordinary edit and must not silently invert a routing.
 */
export interface ConditionalRule {
  /** What the executing model must measure and hand to the scaffold. */
  subject: string;
  operator: RuleOperator;
  /** What the measured value is compared against. */
  operand: string;
  /** The branch taken when the comparison holds. */
  whenTrue: string;
  /** The branch taken when it does not. */
  whenFalse: string;
}

/** True when `value` is a whole number, whatever its magnitude. */
export function isWholeNumber(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

/**
 * How many digits a number in a rule may have.
 *
 * The exported scaffold compares numbers with `[ -gt ]`, i.e. with whatever integer type
 * the shell running the bundle happens to use. POSIX guarantees a signed long, and the
 * smallest signed long a conforming implementation may have is 32 bits — so ±2147483647
 * is the widest range that is *guaranteed* to mean the same thing everywhere, and nine
 * digits is the largest whole number of digits inside it.
 *
 * Stated as a digit count rather than as a maximum value on purpose: it is the form the
 * scaffold can check without doing arithmetic, so the range check itself cannot overflow
 * the very type it is protecting.
 *
 * Past this bound the failure is silent and shell-dependent, which is the one thing the
 * deterministic mode may not be. A 23-digit measured value made `[` fail with "integer
 * expression expected"; the failure was swallowed by the `if` asking the question, and
 * dash, bash and macOS `sh` answered "false" while ksh answered "true" — the same bundle,
 * the same input, opposite branches. Both sides of every comparison are therefore bounded:
 * the operand here, at authoring time, and the measured value by the scaffold at run time.
 */
export const MAX_RULE_NUMBER_DIGITS = 9;

/**
 * True when `value` is a whole number every shell compares the same way — see
 * [`MAX_RULE_NUMBER_DIGITS`].
 *
 * Leading zeros are padding rather than magnitude, so they are stripped before the digits
 * are counted: `0000000009` is nine, not ten.
 */
export function isComparableNumber(value: string): boolean {
  if (!isWholeNumber(value)) return false;
  const digits = value.trim().replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
  return digits.length <= MAX_RULE_NUMBER_DIGITS;
}

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
  /** What the executing model has to decide, in the user's own words (`llm` mode). */
  question: string;
  /**
   * The deterministic check (`rule` mode).
   *
   * Kept when the node is switched back to `llm` rather than deleted, so toggling
   * the mode to look at the other one does not cost the user what they wrote —
   * which is why an ignored rule is not a validation error.
   */
  rule?: ConditionalRule;
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
  | AuthoredArtifactData
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
  /**
   * What this edge's result is called where it arrives.
   *
   * An edge carries a node's output into the next node as context, and where
   * several edges fan into one node those results are concatenated **under their
   * labels** so the consuming step can tell them apart. The label sits on the
   * edge for the same reason the branch does (ADR-0003, and ADR-0005 for this field):
   * the edge is the thing the user draws and the thing the traversal follows.
   *
   * Optional, because the label an edge carries by default is already on the
   * canvas — the source node's own label. Read it through [`inputLabelOf`], never
   * by testing for the field.
   */
  inputLabel?: string;
}

/**
 * What an edge's result is called where it arrives: the label the author gave the
 * edge, else the source node's label, else the source node's id.
 *
 * The fallback chain is what keeps fan-in labels a thing the user *reads off the
 * canvas* rather than a second set of names to maintain: naming the nodes is
 * already how a graph is made legible, and an edge label is the override for when
 * one node feeds two different things into one step.
 */
export function inputLabelOf(
  // Structural rather than the whole node and edge, because the canvas asks this of its
  // *React Flow* edge and node, which carry the same two fields under other names: one
  // rule, asked in both places, instead of a canvas copy of it (see `withInputLabels`).
  edge: Pick<GraphEdge, "source"> & { inputLabel?: string },
  source: { label?: string } | undefined,
): string {
  const explicit = (edge.inputLabel ?? "").trim();
  if (explicit !== "") return explicit;
  const derived = (source?.label ?? "").trim();
  return derived !== "" ? derived : edge.source;
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
 * to `workflow`" (a name that *is* `workflow` is fine) without re-deriving the rule —
 * and so [`authoredArtifactName`], which has no directory to name and no business
 * inventing one, can ask the same question of a node's label.
 * Asking this rather than testing the name against `[a-z0-9]` matters because the slug
 * comes off the *lowercased* name, and lowercasing can make a character usable: `İ`
 * (U+0130) is not `[a-z0-9]`, yet it slugs to `i`.
 */
function rawSlug(name: string): string {
  return name
    // Normalized first, because the slug is also an artifact's *identity* when a node's
    // label names what it authors: `café` typed on a Mac (decomposed) and `café` pasted
    // from the web (composed) are one word to every reader, and without this they slug
    // to `cafe-` and `caf-` — two artifacts, no collision reported between them.
    .normalize("NFC")
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
 * The bundle directory a workflow of this name compiles into — which is also the
 * **namespace** everything in the bundle is invoked under.
 *
 * Stated once and asked by all three surfaces (the compiler, `validateGraph` and the
 * dock) rather than re-derived, because an authored name is only exportable relative
 * to it: see the `bundleDir` argument of [`authoredArtifactErrors`].
 */
export function bundleDirNameFor(workflowName: string): string {
  return `${BUNDLE_DIR_PREFIX}${slugify(workflowName)}`;
}

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

  const authoredProblems = authoredArtifactErrors(doc.nodes, [], bundleDirNameFor(name));
  errors.push(...contentErrors(doc));
  // Asked of the document alone, so a clash with something *installed* is not an
  // export refusal — only the dock passes the catalog. See `authoredArtifactErrors`.
  for (const node of doc.nodes) {
    errors.push(...(authoredProblems.get(node.id) ?? []));
  }
  errors.push(...branchWiringErrors(doc, nodeIds));
  errors.push(...inputLabelErrors(doc));

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
    // Asked of the plan `compile` walks, and of the one already built here: whether two
    // results arrive at a step *together* is a fact about the traversal (see
    // `fanInInputs`), so it can only be answered once the graph can be followed at all.
    errors.push(...fanInErrors(doc, plan));
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
 * An input label lands in the same place a branch label does — an inline code span
 * in the umbrella, which the reading model has to quote back to itself while it
 * assembles a step's context — so it shares both rules rather than inventing a
 * second pair.
 */
const INPUT_LABEL_PATTERN = PARAM_NAME_PATTERN;
export const MAX_INPUT_LABEL_LENGTH = MAX_NAME_SEGMENT_LENGTH;

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
 * How many paths one node may split into.
 *
 * The same number, and the same reasoning, as [`MAX_BRANCHES_PER_CONDITIONAL`]: a
 * split is read as a list of paths to follow, the umbrella writes one nested
 * sub-list per path, and the canvas draws an edge each. It is also what keeps the
 * **edge** count of an accepted document bounded now that any node may fan out —
 * without it, `MAX_WORKFLOW_NODES` bounds only the nodes.
 */
export const MAX_FAN_OUT = MAX_BRANCHES_PER_CONDITIONAL;

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
      // An authored artifact has no source root and no reference to resolve; what it
      // *does* need is checked once, for both surfaces, by `authoredArtifactErrors`.
      if (authoredArtifactOf(node) === undefined) {
        errors.push(...artifactRefErrors(node));
      }
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
  const mode = conditionalModeOf(data);

  // Only what the node's own mode reads. A rule-based conditional states its check
  // instead of a question, and demanding both would ask the user to write prose
  // nothing emits; the *unused* field is kept rather than validated, so switching
  // modes to look at the other one is free.
  if (mode === "llm" && (data.question ?? "").trim() === "") {
    errors.push(
      `Conditional node '${node.id}' has an empty decision question; the exported skill has nothing to decide from`,
    );
  }

  const branches = branchesOf(node);
  if (mode === "rule") errors.push(...ruleErrors(node, data, branches));
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
 * Reject a rule the control scaffold could not evaluate, or could not route.
 *
 * Every rule here is about the *script the compiler will emit*, the way
 * [`conditionalErrors`] is about the prose: the scaffold compares one value against
 * one operand and prints one of two branch labels, so a missing subject leaves the
 * model nothing to measure, a non-numeric operand makes an integer test a runtime
 * error rather than a decision, and a routing that names a branch the node does not
 * offer prints a label nothing in the umbrella answers to.
 *
 * Exactly two branches, because a rule *holds or it does not*. A third branch would
 * be one the scaffold can never name — and an unreachable path in a workflow whose
 * whole selling point is determinism is worse than a refused document.
 */
function ruleErrors(
  node: GraphNode,
  data: ConditionalData,
  branches: readonly Branch[],
): string[] {
  const rule = data.rule;
  if (rule === undefined) {
    return [
      `Conditional node '${node.id}' is rule-based but has no rule; give it a check the control scaffold can evaluate, or switch it back to LLM-based`,
    ];
  }

  const errors: string[] = [];
  if ((rule.subject ?? "").trim() === "") {
    errors.push(
      `Conditional node '${node.id}' has a rule with no subject; the control scaffold needs to be told which value to check`,
    );
  }
  // Blank is blank whatever the comparison; everything past that is asked of the operand
  // as it will actually be compared, which is the string the compiler emits.
  const operand = comparedOperand(rule);
  if (operand.trim() === "") {
    errors.push(
      `Conditional node '${node.id}' has a rule with nothing to compare against; give it a value`,
    );
  } else if (NUMERIC_RULE_OPERATORS.includes(rule.operator)) {
    if (!isWholeNumber(operand)) {
      errors.push(
        `Conditional node '${node.id}' compares '${rule.operator}' against '${rule.operand}', which is not a whole number; a numeric rule needs one`,
      );
    } else if (!isComparableNumber(operand)) {
      // A separate error from "not a number", because it has a separate cause and a
      // separate fix: the value *is* a number, it is simply one no shell agrees about.
      errors.push(
        `Conditional node '${node.id}' compares '${rule.operator}' against '${rule.operand}', which has more than ${MAX_RULE_NUMBER_DIGITS} digits; a rule is compared by a shell, and only numbers up to ${"9".repeat(MAX_RULE_NUMBER_DIGITS)} compare the same way in every shell`,
      );
    }
  }

  if (branches.length !== 2) {
    errors.push(
      `Conditional node '${node.id}' is rule-based and offers ${branches.length} branches; a rule holds or it does not, so it decides between exactly two`,
    );
  }

  const offered = new Map(branches.map((branch) => [branch?.id, branch]));
  for (const [outcome, branchId] of [
    ["true", rule.whenTrue],
    ["false", rule.whenFalse],
  ] as const) {
    if (!offered.has(branchId)) {
      errors.push(
        `Conditional node '${node.id}' routes its rule's ${outcome} case to branch '${branchId}', which that node does not offer`,
      );
    }
  }
  if (rule.whenTrue === rule.whenFalse && offered.has(rule.whenTrue)) {
    errors.push(
      `Conditional node '${node.id}' routes both cases of its rule to branch '${offered.get(rule.whenTrue)?.label}'; a rule chooses between two paths`,
    );
  }

  return errors;
}

/**
 * Reject an input label the step that reads it could not quote.
 *
 * A property of the edge alone, so it is checked for **every** edge and without the plan:
 * a label is written before the graph it belongs to is finished, and "your label has a
 * backtick in it" should not wait on the document becoming walkable.
 */
function inputLabelErrors(doc: PatchworkDocument): string[] {
  const errors: string[] = [];
  for (const edge of doc.edges) {
    const label = (edge.inputLabel ?? "").trim();
    if (label === "") continue;
    if (!INPUT_LABEL_PATTERN.test(label)) {
      errors.push(
        `Edge ${edge.id} carries input label '${edge.inputLabel}' with invalid characters (use letters, digits, spaces, hyphens, or underscores)`,
      );
    }
    if (label.length > MAX_INPUT_LABEL_LENGTH) {
      errors.push(
        `Edge ${edge.id} carries an input label of ${label.length} characters; it is quoted in the step that reads it, so it must be at most ${MAX_INPUT_LABEL_LENGTH} characters`,
      );
    }
  }
  return errors;
}

/**
 * Reject a fan-in whose inputs the consuming step could not tell apart.
 *
 * A fan-in step's context is its upstream results **concatenated under their labels**, so
 * two inputs sharing a label is not a naming quibble: it is a step that cannot say which
 * result it is looking at. Compared case-folded and trimmed for the reason branch labels
 * are — the comparison that matters is the one a *reader* makes.
 *
 * **Which edges those are is [`fanInInputs`]' to say, not this function's**, and that is
 * the whole point of asking the plan rather than the edge list. The first spelling of this
 * check excluded only the edges that leave a conditional *directly*, and so refused an
 * ordinary two-branch workflow: once a branch has a step of its own, the edge arriving at
 * the convergence point carries no branch any more, and two branch bodies whose steps
 * happen to share a label ("Draft" in both) read as an ambiguous fan-in. They are not one
 * — only one branch ever runs, so only one result ever arrives — and the compiler already
 * knew it, because it asks the plan. Now both do, and they cannot disagree about what a
 * step reads.
 */
function fanInErrors(doc: PatchworkDocument, plan: WorkflowPlan): string[] {
  const errors: string[] = [];
  for (const [target, inputs] of fanInInputs(doc, plan)) {
    const seen = new Set<string>();
    for (const input of inputs) {
      const folded = input.label.toLowerCase();
      if (seen.has(folded)) {
        errors.push(
          `Node '${target}' has two incoming paths labelled '${input.label}'; label the edges or rename the nodes so the step can tell its inputs apart`,
        );
      } else {
        seen.add(folded);
      }
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
  const label = nodeLabelFor(artifactKindOf(node.type) as ArtifactKind);
  // Read as possibly-absent, the convention every other read of node data here
  // follows: `validateGraph` is asked of in-memory nodes a hand edit may have emptied,
  // and it owes the user an error list rather than a TypeError (issue #27).
  const ref = node.data as ArtifactRefData | undefined;
  const name = asText(ref?.name).trim();

  if (name === "") {
    errors.push(
      `${label} node '${node.id}' is not bound to an artifact yet (pick one from a source root)`,
    );
  } else if (!isValidArtifactName(name)) {
    // The name is rendered into an inline code span in the umbrella skill.
    errors.push(
      `${label} node '${node.id}' references '${ref?.name}', which is not a usable artifact name`,
    );
  }
  if ((ref?.rootId ?? "").trim() === "") {
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
 * Slice 1 was linear-only. Slice 4 relaxed the shape and slice 7 finished the job:
 *
 * - **Fan-out** is allowed at any node, because there are now two kinds of it and both
 *   are followable — a conditional runs exactly one of its paths, a plain split runs
 *   all of them (ADR-0005). Only the *width* is refused, at [`MAX_FAN_OUT`]; a
 *   conditional's width is governed by its branches instead (see
 *   [`branchWiringErrors`]).
 * - **Fan-in** is not a structural error either: it is what re-convergence looks like
 *   after a conditional, and what a split's paths coming back together looks like.
 *   Whether the merge is a *legitimate* convergence point is decided by the plan check
 *   in `validateGraph`, which asks the same traversal the compiler walks; whether its
 *   inputs can be told apart is [`fanInErrors`]'.
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
    // A plain split is a fan-out where *every* path is followed; a conditional is
    // one where exactly one is. Both are followable, so neither is refused — only
    // the width is, and a conditional's width is governed by its branches instead
    // (see [`branchWiringErrors`] and [`conditionalErrors`]).
    if (out > MAX_FAN_OUT && node.type !== "conditional") {
      errors.push(
        `Node '${node.id}' splits into ${out} paths; at most ${MAX_FAN_OUT} can be written as a list a reader could follow. Merge some of them before splitting again.`,
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
 * contains became invalid. It is still true for v6 -> v7, which adds an artifact
 * node's `source`: `assertNodeShape` reads its *absence* as an imported reference and
 * checks exactly the contract a v6 node already satisfied. The first migration that *renames or retypes* a node's
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
  // v4 -> v5: the `rule` conditional mode with the rule it selects, and an edge's
  // `inputLabel`. Widenings again — a v4 conditional has no `mode` or an `llm` one,
  // which is exactly what it still means, and no v4 edge carries an input label — so
  // a v4 document is already a valid v5 document.
  4: (doc) => ({ ...doc, schemaVersion: 5 }),
  // v5 -> v6: a cycle may carry an iteration guard. Another widening, and not this
  // slice's — the step is kept so the chain has no hole and a v5 document still walks
  // all the way forward. See [`CURRENT_SCHEMA_VERSION`].
  5: (doc) => ({ ...doc, schemaVersion: 6 }),
  // v6 -> v7: a `skill`/`agent` node's artifact may be authored in the graph. A
  // widening again — an artifact node with no `source` is an imported reference,
  // which is exactly what every earlier artifact node already was — so a v6 document is
  // already a valid v7 document and the migration only records the version.
  6: (doc) => ({ ...doc, schemaVersion: 7 }),
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
      // Absent is fine — that is every document written before authoring existed, and
      // `artifactSourceOf` reads it as an imported reference. An unknown value is not:
      // the two sources are read by *different* contracts below, so guessing would
      // mean checking the wrong one and letting a malformed node through.
      if (
        data.source !== undefined &&
        !ARTIFACT_SOURCES.includes(data.source as ArtifactSource)
      ) {
        throw new Error(
          `${label} node '${id}' has an invalid 'source' '${String(data.source)}' (expected one of ${ARTIFACT_SOURCES.join(", ")})`,
        );
      }
      if (data.source === "authored") {
        // The fields the codec composes an artifact out of. `name` is optional
        // (a skill takes its node's label — see `authoredArtifactName`), and so are
        // the Advanced ones; whether what is there is *usable* is `validateGraph`'s.
        for (const field of ["description", "body"] as const) {
          if (typeof data[field] !== "string") {
            throw new Error(
              `${label} node '${id}' authors an artifact and must have a string '${field}' (found ${describeType(data[field])})`,
            );
          }
        }
        for (const field of ["name", "tools", "model", "effort"] as const) {
          assertOptionalText(data[field], `${label} node '${id}' '${field}'`);
        }
        break;
      }
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
      // The rule's *shape*, for the same reason every other `data` contract is checked
      // here: `validateGraph` and the scaffold emitter both read these fields as
      // strings, and a number or an object would surface as a TypeError far from the
      // file that caused it. Whether the rule makes sense is `validateGraph`'s.
      if (data.rule !== undefined) assertRuleShape(id, data.rule);
      break;
    }
  }
}

/** Reject a rule whose fields the scaffold emitter could not render. */
function assertRuleShape(id: string, raw: unknown): void {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(
      `Conditional node '${id}' must have a 'rule' object (found ${describeType(raw)})`,
    );
  }
  const rule = raw as Record<string, unknown>;
  for (const field of ["subject", "operand", "whenTrue", "whenFalse"] as const) {
    if (typeof rule[field] !== "string") {
      throw new Error(
        `Conditional node '${id}' must have a string '${field}' in its rule (found ${describeType(rule[field])})`,
      );
    }
  }
  // An unknown operator is refused rather than defaulted, the way an unknown export
  // mode is: guessing which comparison the author meant would decide the routing of
  // a workflow on their behalf, and this is the mode whose promise is determinism.
  if (!RULE_OPERATORS.includes(rule.operator as RuleOperator)) {
    throw new Error(
      `Conditional node '${id}' has a rule with an invalid 'operator' '${String(rule.operator)}' (expected one of ${RULE_OPERATORS.join(", ")})`,
    );
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
  // Likewise for what the edge's result is called where it arrives: the type is the
  // load boundary's business, the charset and the length are `validateGraph`'s.
  assertOptionalText(edge.inputLabel, `edge at index ${index} 'inputLabel'`);
}
