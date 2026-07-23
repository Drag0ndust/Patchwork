/**
 * The Graph Document: Patchwork's own persisted `.patchwork` schema.
 *
 * This is deliberately NOT React Flow's internal JSON. React Flow node
 * positions are kept under an optional `position` field for round-tripping the
 * canvas, but the document itself is the source of truth for compilation.
 */

export const CURRENT_SCHEMA_VERSION = 1;

export type NodeType = "input" | "prompt" | "output";

const NODE_TYPES: NodeType[] = ["input", "prompt", "output"];

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

export type NodeData = InputData | PromptData | OutputData;

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
    }
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
  if (doc.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schemaVersion ${doc.schemaVersion} (expected ${CURRENT_SCHEMA_VERSION}). This file was created by a different version of Patchwork.`,
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
  if (!Array.isArray(doc.nodes)) {
    throw new Error("Malformed Patchwork document: 'nodes' must be an array");
  }
  if (!Array.isArray(doc.edges)) {
    throw new Error("Malformed Patchwork document: 'edges' must be an array");
  }

  doc.nodes.forEach(assertNodeShape);
  doc.edges.forEach(assertEdgeShape);

  return parsed as PatchworkDocument;
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
      `Node '${id}' has invalid type '${String(node.type)}' (expected input, prompt, or output)`,
    );
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
  }
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
