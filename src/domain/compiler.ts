/**
 * The Graph Compiler: a PURE transform from a Patchwork document to an
 * in-memory bundle tree. No disk IO happens here — writing the tree to disk is
 * the Bundle Emitter's job (a privileged Rust command).
 *
 * Slice 1 emits a single umbrella `SKILL.md` whose prose encodes the linear
 * Input -> Prompt(s) -> Output chain. There is no control scaffold yet: the
 * ordering lives entirely in the Markdown body.
 */

import { stringify as stringifyYaml } from "yaml";
import { isValidArtifactName } from "./artifact-codec";
import { artifactKindOf } from "./graph-document";
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
 * Turn a workflow name into a filesystem/skill-safe slug. Falls back to
 * `"workflow"` so `name`/`dirName` are never empty even for punctuation-only or
 * non-ASCII names (validation rejects those at export; this is defence in depth).
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "workflow";
}

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

/**
 * Render one step of the chain.
 *
 * A `Prompt` node inlines its instruction. A `Skill`/`Agent` node is emitted as
 * **reference-by-name**: the prose tells Claude Code to invoke the artifact the
 * user already has installed. The artifact body is deliberately NOT copied into
 * the bundle — vendor-copy is a separate, per-node export choice.
 */
function stepInstruction(node: GraphNode): string {
  switch (node.type) {
    case "skill":
      return `Invoke the \`${artifactSpanText((node.data as ArtifactRefData).name)}\` skill with the Skill tool, then use its result in the next step.`;
    case "agent":
      return `Delegate to the \`${artifactSpanText((node.data as ArtifactRefData).name)}\` subagent with the Task tool, then use its result in the next step.`;
    default:
      return sanitizeInline((node.data as PromptData | undefined)?.instruction);
  }
}

/** The referenced (not bundled) artifacts, deduplicated, in chain order. */
function referencedArtifacts(ordered: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return ordered.filter((node) => {
    const kind = artifactKindOf(node.type);
    if (!kind) return false;
    const key = `${kind} ${(node.data as ArtifactRefData).name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderSkill(doc: PatchworkDocument, ordered: GraphNode[]): string {
  const slug = slugify(doc.workflow.name ?? "");
  const description = doc.workflow.description ?? "";

  const input = ordered.find((n) => n.type === "input");
  const steps = ordered.filter((n) => n.type !== "input" && n.type !== "output");
  const references = referencedArtifacts(ordered);
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

  if (references.length > 0) {
    lines.push("## Requirements");
    lines.push("");
    lines.push(
      "This workflow references capabilities by name — they are not bundled here, so they must already be installed in Claude Code:",
    );
    lines.push("");
    for (const node of references) {
      const name = artifactSpanText((node.data as ArtifactRefData).name);
      lines.push(`- ${node.type === "skill" ? "skill" : "subagent"} \`${name}\``);
    }
    lines.push("");
  }

  lines.push("## Steps");
  lines.push("");
  if (steps.length === 0) {
    lines.push("_No steps defined._");
  } else {
    steps.forEach((step, index) => {
      lines.push(`${index + 1}. ${stepInstruction(step)}`);
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

/** Compile a document into an in-memory bundle tree. Pure — no IO. */
export function compile(doc: PatchworkDocument): BundleTree {
  const ordered = linearOrder(doc);
  return {
    dirName: `patchwork-${slugify(doc.workflow.name ?? "")}`,
    files: [{ path: "SKILL.md", contents: renderSkill(doc, ordered) }],
  };
}
