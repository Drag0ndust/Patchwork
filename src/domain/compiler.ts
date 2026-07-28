/**
 * The Graph Compiler: a PURE transform from a Patchwork document to an
 * in-memory bundle tree. No disk IO happens here — writing the tree to disk is
 * the Bundle Emitter's job (a privileged Rust command).
 *
 * Slice 1 emits a single umbrella `SKILL.md` whose prose encodes the linear
 * Input -> Prompt(s) -> Output chain. There is no control scaffold yet: the
 * ordering lives entirely in the Markdown body.
 *
 * Slice 3 adds vendor-copy: a `skill`/`agent` node whose stored export mode is
 * `vendor` also contributes the artifact's own file(s) to the tree. Copying is a
 * pure transform because the bytes are already in memory — the caller passes the
 * artifacts it resolved, so the compiler never reaches for the disk and never
 * learns about the import layer (see ADR-0002).
 */

import { stringify as stringifyYaml } from "yaml";
import {
  artifactRelativePath,
  emitArtifact,
  isValidArtifactName,
  parseArtifactLocation,
  type Artifact,
  type ArtifactKind,
} from "./artifact-codec";
import {
  artifactKindOf,
  BUNDLE_DIR_PREFIX,
  exportModeOf,
  slugify,
} from "./graph-document";
import type {
  ArtifactRefData,
  GraphNode,
  InputData,
  OutputData,
  PatchworkDocument,
  PromptData,
} from "./graph-document";

export interface BundleFile {
  path: string;
  contents: string;
}

export interface BundleTree {
  dirName: string;
  files: BundleFile[];
}

/**
 * Re-exported for the emitter's callers: the slug rule lives with the workflow
 * name it derives from, because `validateGraph` has to bound its length too.
 */
export { slugify };

/** True if `ch` is a printable ASCII punctuation character (per CommonMark). */
function isAsciiPunctuation(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) || // ! " # $ % & ' ( ) * + , - . /
    (code >= 0x3a && code <= 0x40) || // : ; < = > ? @
    (code >= 0x5b && code <= 0x60) || // [ \ ] ^ _ `
    (code >= 0x7b && code <= 0x7e) //    { | } ~
  );
}

/**
 * Sanitize a single untrusted field value before it is rendered into the
 * Markdown body. This is the one place that routes untrusted content safely,
 * and it is LOSSLESS for prose — it never rewrites the user's characters.
 *
 * Rather than enumerate block markers (which is whack-a-mole — `#`, `~~~`,
 * `<h1>`, `___`, `|`, ...), it closes the whole class generally: every
 * Markdown/HTML block construct is triggered by the LEADING character(s) at
 * column 0, so neutralizing only the leading character neutralizes all of them.
 *
 * 1. Collapse newlines/whitespace to a single line (no multi-line block can
 *    form), and trim.
 * 2. Backslash-escape the leading character if it is any ASCII punctuation.
 *    This defuses every block-starter — including a leading fence run like
 *    `~~~` or ` ``` ` (the line no longer starts with the fence) — while the
 *    escaped character still renders as its literal self.
 * 3. Ordered lists start with digits (not punctuation) then `.`/`)`, so escape
 *    that delimiter as the one non-punctuation-led case.
 *
 * Characters after the first are left untouched, so `~/notes` and inline code
 * like `` `npm build` `` survive verbatim. Backticks in a *parameter name*
 * (the one code-span context) are handled at the source: `validateGraph`
 * constrains parameter names to a safe charset.
 */
/**
 * Render an untrusted value inside an inline code span. A code span cannot
 * start a block, so it needs NO leading-marker escaping — and backslash escapes
 * do not work inside code spans (CommonMark §6.1), so applying the prose
 * escaper here would surface a literal `\`. It only needs to be free of
 * backticks and newlines, which the parameter-name charset + validation already
 * guarantee; here we just collapse whitespace and trim.
 */
function codeSpanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Render an artifact name inside an inline code span.
 *
 * `validateGraph` constrains names to [`isValidArtifactName`], and `handleExport`
 * validates before compiling — but the umbrella emitter is the boundary against
 * *hand-edited* documents, where `assertNodeShape` only requires `data.name` to
 * be a string. A backtick would then close the span early and let the rest of the
 * name escape into prose, corrupting a document the user cannot see the source of.
 *
 * An invalid name is emitted with its backticks stripped rather than dropped: the
 * reference stays visibly wrong (and is flagged unresolved on the canvas) instead
 * of quietly deforming the surrounding Markdown.
 */
function artifactSpanText(value: string | undefined): string {
  const text = codeSpanText(value);
  return isValidArtifactName(text) ? text : text.replace(/`/g, "");
}

function sanitizeInline(value: string | undefined): string {
  const collapsed = (value ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

  if (collapsed.length === 0) return collapsed;

  const ordered = collapsed.match(/^(\d+)([.)])/);
  if (ordered) {
    return collapsed.replace(/^(\d+)([.)])/, "$1\\$2");
  }
  if (isAsciiPunctuation(collapsed[0])) {
    return `\\${collapsed}`;
  }
  return collapsed;
}

/**
 * Order the linear chain from the Input node to the Output node by following
 * edges. Falls back to document order for any nodes not reachable from Input
 * (a malformed graph should be rejected by `validateGraph` before compiling).
 */
function linearOrder(doc: PatchworkDocument): GraphNode[] {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const nextOf = new Map<string, string>();
  for (const edge of doc.edges) {
    nextOf.set(edge.source, edge.target);
  }

  const input = doc.nodes.find((n) => n.type === "input");
  if (!input) return [...doc.nodes];

  const ordered: GraphNode[] = [];
  const seen = new Set<string>();
  let current: GraphNode | undefined = input;
  while (current && !seen.has(current.id)) {
    ordered.push(current);
    seen.add(current.id);
    const nextId = nextOf.get(current.id);
    current = nextId ? byId.get(nextId) : undefined;
  }

  // Append any unreachable nodes so nothing is silently dropped.
  for (const node of doc.nodes) {
    if (!seen.has(node.id)) ordered.push(node);
  }
  return ordered;
}

/** The identity of an artifact reference: its kind and the name it was bound to. */
function artifactKey(kind: ArtifactKind, name: string): string {
  return `${kind} ${name}`;
}

/** One vendored artifact: where its bytes land, and what it is called there. */
interface VendoredCopy {
  kind: ArtifactKind;
  /** The name it has in the user's source roots, for prose about its origin. */
  sourceName: string;
  /**
   * The **bare** name it has inside the bundle. A vendored artifact loses its
   * source namespace (there is no plugin directory in the bundle) and gains the
   * bundle's, so `coding:tdd` is copied to `skills/tdd/` and invoked as
   * `patchwork-<slug>:tdd`.
   */
  bundleName: string;
  path: string;
  contents: string;
}

/**
 * What the bundle contains, decided once so the file set and the prose cannot
 * disagree about a name.
 */
interface BundlePlan {
  dirName: string;
  /** Vendored artifacts by [`artifactKey`] of their *source* name, chain order. */
  vendored: Map<string, VendoredCopy>;
  /** Reference-mode artifact nodes, deduplicated, in chain order. */
  references: GraphNode[];
  /**
   * Why a node that asked for a copy did not get one, in the words of the node
   * the user has to fix. Surfaced by [`vendorErrors`] — the plan is the single
   * place that decides what is copied, so it is also the only place that can say
   * why something was not.
   */
  problems: string[];
}

/**
 * The name Claude Code invokes a vendored artifact by.
 *
 * The bundle directory is itself the enclosing namespace, so the source name is
 * NOT what resolves inside it — emitting `coding:tdd` for a copy that lives at
 * `patchwork-x/skills/tdd/SKILL.md` would send Claude Code looking for an
 * artifact the bundle deliberately stopped depending on. See ADR-0002.
 */
function invocationName(plan: BundlePlan, copy: VendoredCopy): string {
  return `${plan.dirName}:${copy.bundleName}`;
}

/**
 * How a bundled name is claimed, so that two copies can never land on one file.
 *
 * Case-folded, because the bundle is written to a **filesystem**, and the default
 * one on macOS (APFS) and Windows (NTFS) treats `skills/tdd/` and `skills/TDD/`
 * as the same directory: emitting both would silently overwrite the first copy
 * with the second. Folding is enough and no Unicode normalization is needed —
 * `isValidArtifactName` admits only ASCII letters, digits, `.`, `_` and `-`, so
 * there is no case-folding subtlety and no decomposable character to normalize.
 */
function bundleNameClaim(kind: ArtifactKind, name: string): string {
  return artifactKey(kind, name.toLowerCase());
}

/**
 * Pick the bare name a vendored artifact gets inside the bundle.
 *
 * The leaf is preferred, because that is the shortest name that still reads like
 * the artifact the user picked. Two vendored artifacts can share a leaf, though
 * (`coding:tdd` and `swift:tdd`), and they cannot share a path — so a taken leaf
 * falls back to the flattened source name, then to a numeric suffix. First come
 * keeps the leaf, which makes the choice a function of chain order rather than of
 * iteration accident, and no copy is ever silently overwritten.
 */
function chooseBundleName(
  kind: ArtifactKind,
  sourceName: string,
  taken: Set<string>,
): string {
  const free = (candidate: string) => !taken.has(bundleNameClaim(kind, candidate));

  const leaf = sourceName.split(":").pop() as string;
  if (free(leaf)) return leaf;
  const flattened = sourceName.replace(/:/g, "-");
  if (free(flattened)) return flattened;
  // Terminates: each iteration proposes a name no earlier one proposed, and
  // `taken` is finite — so a free candidate is reached within `taken.size` steps.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${flattened}-${suffix}`;
    if (free(candidate)) return candidate;
  }
}

/**
 * The node that asked for each artifact to be copied, keyed by [`artifactKey`].
 *
 * The export mode is a property of the *artifact* in the bundle, not of the node:
 * a file is either copied in or it is not, so two nodes bound to one artifact
 * cannot each have their way. This pass therefore settles the question for every
 * key **before** any node is planned. An explicit vendor-copy wins wherever it
 * sits in the chain — deciding from the first node encountered would drop a copy
 * the user asked for because some other node happened to come earlier, which is
 * exactly the kind of silent loss the choice must not be subject to.
 *
 * The *first* vendor-mode node is the one remembered, so a diagnostic names the
 * same node every time.
 */
function vendorRequests(ordered: GraphNode[]): Map<string, GraphNode> {
  const requests = new Map<string, GraphNode>();
  for (const node of ordered) {
    const kind = artifactKindOf(node.type);
    if (!kind) continue;
    const ref = node.data as ArtifactRefData;
    if (exportModeOf(ref) !== "vendor") continue;
    const key = artifactKey(kind, ref.name);
    if (!requests.has(key)) requests.set(key, node);
  }
  return requests;
}

/** `Skill`/`Agent`, the way the errors and the document's own validation say it. */
function nodeLabel(kind: ArtifactKind): string {
  return kind === "skill" ? "Skill" : "Agent";
}

/** Either the copy a vendor-mode node asked for, or why it cannot have one. */
type CopyAttempt = { copy: VendoredCopy } | { problem: string };

/**
 * Try to turn one vendor-mode request into a copy.
 *
 * Both refusals are phrased for the node the user has to fix, because that is the
 * only place they can act: by the time a bundle is on disk, a missing copy looks
 * like a Claude Code failure rather than an export decision.
 */
function attemptCopy(
  requestedBy: GraphNode,
  kind: ArtifactKind,
  name: string,
  artifact: Artifact | undefined,
  taken: Set<string>,
): CopyAttempt {
  const prefix = `${nodeLabel(kind)} node '${requestedBy.id}' is set to copy '${name}' into the bundle, but`;
  if (!artifact) {
    return {
      problem: `${prefix} that artifact is not in any configured source root right now — restore the root, re-pick the artifact, or switch the node to reference-by-name`,
    };
  }

  // Self-checking rather than trusting provenance: `bundleName` becomes a path
  // component and an inline code span, and a caller could hand us an artifact
  // that never went through the codec's name validation.
  const bundleName = chooseBundleName(kind, artifact.name, taken);
  if (!isValidArtifactName(bundleName)) {
    return {
      problem: `${prefix} '${bundleName}' is not a name a copy can be given inside the bundle — re-pick the artifact or switch the node to reference-by-name`,
    };
  }

  // And the path has to name the copy back. `artifactRelativePath` is not
  // injective in the other direction for every input: an agent named `SKILL` lands
  // at `agents/SKILL.md`, which the layout rule says is not an artifact at all — so
  // the copy would sit in the bundle under a name nothing resolves. Asserting the
  // round trip closes that whole class instead of banning one name.
  const path = artifactRelativePath(kind, bundleName);
  const located = parseArtifactLocation(path);
  if (located?.kind !== kind || located.name !== bundleName) {
    return {
      problem: `${prefix} a copy at '${path}' would not be discoverable as '${bundleName}' — re-pick the artifact or switch the node to reference-by-name`,
    };
  }

  return {
    copy: {
      kind,
      sourceName: artifact.name,
      bundleName,
      path,
      contents: emitArtifact(artifact),
    },
  };
}

/**
 * Decide, per artifact, whether it is copied into the bundle or named in the
 * prose — and under which name.
 *
 * An artifact that cannot be copied degrades to reference-by-name rather than
 * emitting an empty file, and records why: `compile` is total, and the export
 * path refuses up front with [`vendorErrors`] so the user hears about it in terms
 * of a node rather than a missing file in the bundle.
 */
function planBundle(
  dirName: string,
  ordered: GraphNode[],
  artifacts: readonly Artifact[],
): BundlePlan {
  const available = new Map(
    artifacts.map((a) => [artifactKey(a.kind, a.name), a]),
  );
  const requests = vendorRequests(ordered);
  const plan: BundlePlan = {
    dirName,
    vendored: new Map(),
    references: [],
    problems: [],
  };
  const seen = new Set<string>();
  const takenBundleNames = new Set<string>();

  for (const node of ordered) {
    const kind = artifactKindOf(node.type);
    if (!kind) continue;
    const ref = node.data as ArtifactRefData;
    const key = artifactKey(kind, ref.name);
    if (seen.has(key)) continue;
    seen.add(key);

    const requestedBy = requests.get(key);
    if (requestedBy) {
      const attempt = attemptCopy(
        requestedBy,
        kind,
        ref.name,
        available.get(key),
        takenBundleNames,
      );
      if ("copy" in attempt) {
        takenBundleNames.add(bundleNameClaim(kind, attempt.copy.bundleName));
        plan.vendored.set(key, attempt.copy);
        continue;
      }
      plan.problems.push(attempt.problem);
    }
    // Not copied, for whatever reason: the umbrella still names the artifact, so
    // the step is never silently dropped from the workflow.
    plan.references.push(node);
  }

  return plan;
}

/**
 * Render one step of the chain.
 *
 * A `Prompt` node inlines its instruction. A `Skill`/`Agent` node is emitted as
 * an invocation of the artifact by the name it has *where the workflow runs*:
 * its own name when it is referenced, the bundled name when it was copied in.
 *
 * A vendored step also states the copy's path **inside the step**, not only in
 * `## Bundled capabilities`. The step is the part that gets acted on, and a
 * bundled name resolves only if the runtime grants the bundle its namespace; the
 * path is reachable either way, so it belongs where the instruction is.
 */
function stepInstruction(node: GraphNode, plan: BundlePlan): string {
  const kind = artifactKindOf(node.type);
  if (!kind) {
    return sanitizeInline((node.data as PromptData | undefined)?.instruction);
  }
  const ref = node.data as ArtifactRefData;
  const copy = plan.vendored.get(artifactKey(kind, ref.name));
  const name = artifactSpanText(copy ? invocationName(plan, copy) : ref.name);
  const where = copy
    ? ` — it is bundled here at \`${codeSpanText(copy.path)}\`, so read that file if the name does not resolve — `
    : ", ";
  return kind === "skill"
    ? `Invoke the \`${name}\` skill with the Skill tool${where}then use its result in the next step.`
    : `Delegate to the \`${name}\` subagent with the Task tool${where}then use its result in the next step.`;
}

/** How the umbrella's prose names an artifact of this kind. */
function artifactNoun(kind: ArtifactKind): string {
  return kind === "skill" ? "skill" : "subagent";
}

/** The bundle directory a document compiles into. */
function bundleDirName(doc: PatchworkDocument): string {
  return `${BUNDLE_DIR_PREFIX}${slugify(doc.workflow.name ?? "")}`;
}

/**
 * Report every node that asked for a copy the bundle cannot contain — the export
 * path's precondition, checked before a directory is even chosen.
 *
 * It runs the *same* plan `compile` runs rather than re-deriving the conditions,
 * so the check and the emitted bundle can never disagree about what was copied.
 * Reference-mode nodes are deliberately absent: naming an artifact never needs to
 * read it, so an unresolved reference stays a notice rather than blocking the
 * export.
 */
export function vendorErrors(
  doc: PatchworkDocument,
  artifacts: readonly Artifact[],
): string[] {
  return planBundle(bundleDirName(doc), linearOrder(doc), artifacts).problems;
}

function renderSkill(
  doc: PatchworkDocument,
  ordered: GraphNode[],
  plan: BundlePlan,
): string {
  const slug = slugify(doc.workflow.name ?? "");
  const description = doc.workflow.description ?? "";

  const input = ordered.find((n) => n.type === "input");
  const steps = ordered.filter((n) => n.type !== "input" && n.type !== "output");
  const output = ordered.find((n) => n.type === "output");

  const rawParameters = (input?.data as InputData | undefined)?.parameters;
  const parameters = Array.isArray(rawParameters) ? rawParameters : [];

  const lines: string[] = [];

  // Serialize frontmatter through a real YAML emitter so descriptions with
  // colons, leading indicators, quotes, or newlines stay valid YAML.
  // `lineWidth: 0` disables line folding so long scalars are not wrapped.
  const frontmatter = stringifyYaml(
    { name: slug, description },
    { lineWidth: 0 },
  ).replace(/\n+$/, "");
  lines.push("---", ...frontmatter.split("\n"), "---");
  lines.push("");
  lines.push(`# ${sanitizeInline(doc.workflow.name) || "Workflow"}`);
  lines.push("");
  const bodyDescription = sanitizeInline(description);
  if (bodyDescription) {
    lines.push(bodyDescription);
    lines.push("");
  }
  lines.push(
    "Run this workflow by following the steps below in order. Each step builds on the previous one; the final result is described under Output.",
  );
  lines.push("");

  lines.push("## Parameters");
  lines.push("");
  if (parameters.length === 0) {
    lines.push("This workflow takes no parameters.");
  } else {
    for (const param of parameters) {
      const name = codeSpanText(param.name);
      const desc = sanitizeInline(param.description);
      lines.push(desc ? `- \`${name}\`: ${desc}` : `- \`${name}\``);
    }
  }
  lines.push("");

  if (plan.references.length > 0) {
    lines.push("## Requirements");
    lines.push("");
    lines.push(
      "This workflow references capabilities by name — they are not bundled here, so they must already be installed in Claude Code:",
    );
    lines.push("");
    for (const node of plan.references) {
      const kind = artifactKindOf(node.type) as ArtifactKind;
      const name = artifactSpanText((node.data as ArtifactRefData).name);
      lines.push(`- ${artifactNoun(kind)} \`${name}\``);
    }
    lines.push("");
  }

  // Kept apart from Requirements on purpose: what ships with the bundle and what
  // has to be installed alongside it are different obligations for the reader.
  if (plan.vendored.size > 0) {
    lines.push("## Bundled capabilities");
    lines.push("");
    lines.push(
      "These capabilities are copied into this bundle, so nothing has to be installed for them. Invoke each by its bundled name — inside this bundle it is the name below, not the name it has where it was copied from:",
    );
    lines.push("");
    for (const copy of plan.vendored.values()) {
      lines.push(
        `- ${artifactNoun(copy.kind)} \`${artifactSpanText(invocationName(plan, copy))}\` — bundled at \`${codeSpanText(copy.path)}\`, copied from \`${artifactSpanText(copy.sourceName)}\``,
      );
    }
    lines.push("");
  }

  lines.push("## Steps");
  lines.push("");
  if (steps.length === 0) {
    lines.push("_No steps defined._");
  } else {
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${stepInstruction(step, plan)}`);
    });
  }
  lines.push("");

  lines.push("## Output");
  lines.push("");
  lines.push("Return the following as the final result:");
  lines.push("");
  lines.push(sanitizeInline((output?.data as OutputData | undefined)?.description));

  return lines.join("\n") + "\n";
}

/**
 * Compile a document into an in-memory bundle tree. Pure — no IO.
 *
 * `artifacts` are the parsed artifacts the caller resolved for this document; a
 * vendor-mode node copies the one matching its kind and name. Passing none is
 * the reference-by-name-only export.
 */
export function compile(
  doc: PatchworkDocument,
  artifacts: readonly Artifact[] = [],
): BundleTree {
  const ordered = linearOrder(doc);
  const dirName = bundleDirName(doc);
  const plan = planBundle(dirName, ordered, artifacts);
  return {
    dirName,
    // Order is a contract with the Bundle Emitter, which writes the files in
    // sequence: it decides what a *partially* written bundle looks like when an
    // export fails halfway (a full disk, a revoked permission, a dropped volume).
    //
    // The copies go first, then the plugin marker, and the umbrella last. Those
    // last two are what make the bundle visible: the marker mints the
    // `patchwork-<slug>:` namespace the copies are invoked under, and the umbrella
    // is the entry point whose prose instructs the steps. Written last, a
    // half-finished export is simply not discoverable — whereas committing them
    // first would publish a plugin that instructs steps whose artifacts are not on
    // disk yet, which is a worse failure than no bundle at all.
    files: [
      ...[...plan.vendored.values()].map((copy) => ({
        path: copy.path,
        contents: copy.contents,
      })),
      ...pluginManifest(doc, plan),
      { path: "SKILL.md", contents: renderSkill(doc, ordered, plan) },
    ],
  };
}

/** The marker directory that makes a directory a plugin, and its manifest file. */
const PLUGIN_MANIFEST_PATH = ".claude-plugin/plugin.json";

/**
 * The plugin manifest, emitted **only** when the bundle vendors something.
 *
 * A vendored artifact is invoked as `patchwork-<slug>:<leaf>`, and by the layout
 * rule this project encodes in both languages (ADR-0001), a directory below
 * `skills/` provides that namespace only when it carries a `.claude-plugin/`
 * marker — the Rust walk's own test asserts that the unmarked shape yields
 * nothing. Without the manifest every bundled name in the umbrella would be a
 * name nothing resolves, so the marker is not decoration: it is what makes the
 * emitted prose true.
 *
 * A reference-only bundle stays a plain skill directory. It claims no namespace,
 * so marking it as a plugin would assert something it does not need.
 *
 * `JSON.stringify` is the escaping boundary for the workflow's untrusted name and
 * description here, the way `stringifyYaml` is for the umbrella's frontmatter.
 */
function pluginManifest(doc: PatchworkDocument, plan: BundlePlan): BundleFile[] {
  if (plan.vendored.size === 0) return [];
  return [
    {
      path: PLUGIN_MANIFEST_PATH,
      contents: `${JSON.stringify(
        { name: plan.dirName, description: doc.workflow.description ?? "" },
        null,
        2,
      )}\n`,
    },
  ];
}
