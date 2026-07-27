/**
 * The Graph Document: Patchwork's own persisted `.patchwork` schema.
 *
 * This is deliberately NOT React Flow's internal JSON. React Flow node
 * positions are kept under an optional `position` field for round-tripping the
 * canvas, but the document itself is the source of truth for compilation.
 */

import { isValidArtifactName, type ArtifactKind } from "./artifact-codec";

/**
 * Bumped to 2 in slice 2: the palette grew `skill`/`agent` nodes that carry an
 * imported artifact reference. `deserialize` migrates older documents forward.
 */
export const CURRENT_SCHEMA_VERSION = 2;

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
  if (!/[a-z0-9]/i.test(name)) {
    errors.push(
      `Workflow name must contain at least one letter or digit usable in a file name ("${name}" produces an empty name)`,
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
 */
const MIGRATIONS: Record<number, (doc: PatchworkDocument) => PatchworkDocument> = {
  // v1 -> v2: `skill`/`agent` nodes were added to the palette. No existing
  // field changed shape, so a v1 document is already a valid v2 document.
  1: (doc) => ({ ...doc, schemaVersion: 2 }),
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
