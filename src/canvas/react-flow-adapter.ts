import type { Edge, Node } from "@xyflow/react";
import {
  branchesWithinLimit,
  CURRENT_SCHEMA_VERSION,
  MAX_BRANCHES_PER_CONDITIONAL,
  artifactKindOf,
  type ArtifactRefData,
  type Branch,
  type ConditionalData,
  type GraphEdge,
  type NodeData,
  type NodeType,
  type PatchworkDocument,
  type WorkflowMeta,
} from "../domain/graph-document";
import { findCatalogArtifact, type ImportCatalog } from "../import/catalog";

/** Data carried on each React Flow node. */
export interface PatchNodeData extends Record<string, unknown> {
  label: string;
  node: NodeData;
  /**
   * Set on `skill`/`agent` nodes whose imported artifact is not in any
   * configured root right now. Derived state — never persisted, because the
   * document stores the reference symbolically and resolution re-runs on open.
   */
  unresolved?: boolean;
}

export type PatchNode = Node<PatchNodeData>;

export interface FlowGraph {
  nodes: PatchNode[];
  edges: Edge[];
}

const DEFAULT_POSITION = { x: 0, y: 0 };

/** Map a Patchwork document into React Flow nodes/edges for the canvas. */
export function documentToFlow(doc: PatchworkDocument): FlowGraph {
  const nodes: PatchNode[] = doc.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { ...DEFAULT_POSITION },
    data: { label: n.label, node: n.data },
  }));
  const edges: Edge[] = doc.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // A conditional offers one source handle per branch, so the branch an edge
    // leaves by *is* the handle it comes out of. Absent for every other node,
    // which has a single unnamed source handle.
    sourceHandle: e.branch,
  }));
  return { nodes, edges: withBranchLabels(nodes, edges) };
}

/** The branches a canvas node offers — empty for anything but a conditional. */
function branchesOfFlowNode(node: PatchNode): Branch[] {
  if (node.type !== "conditional") return [];
  const branches = (node.data.node as ConditionalData).branches;
  return Array.isArray(branches) ? branches : [];
}

/**
 * Show each branch edge's label on the canvas.
 *
 * Derived state, never persisted: the label belongs to the branch on the node, so
 * renaming a branch re-labels its edges without the edge list being touched — and a
 * saved document cannot hold a label that disagrees with the node's.
 *
 * An edge naming a branch the node no longer offers keeps showing the raw branch id
 * rather than going blank: that is a wiring the user has to fix, and `validateGraph`
 * names it, so the canvas should not hide it.
 *
 * Identity-stable when nothing changed, for the same reason [`applyResolution`] is:
 * App derives the rendered edges on every render, and a fresh array each time would
 * re-render the canvas.
 */
export function withBranchLabels(
  nodes: readonly PatchNode[],
  edges: readonly Edge[],
): Edge[] {
  // A label per branch, per node. Nested maps rather than a `${node} ${branch}` key,
  // because a branch id is an arbitrary string in a hand-edited document: node `n1`
  // with branch `x y` and node `n1 x` with branch `y` produce the same joined key, and
  // one edge would then show the other node's label. `validateGraph` refuses such a
  // document, but the canvas is what the user reads *while* fixing it.
  const branchLabels = new Map<string, Map<string, string>>();
  for (const node of nodes) {
    const labels = new Map<string, string>();
    for (const branch of branchesOfFlowNode(node)) {
      // Guarded like every other read of a branch entry: the array's *entries* are the schema's
      // guarantee, not `branchesOf`'s, and a caller can hand this a document `deserialize` never
      // saw. A malformed entry contributes no label rather than a thrown TypeError.
      if (branch?.id === undefined) continue;
      labels.set(branch.id, (branch.label ?? "").trim());
    }
    if (labels.size > 0) branchLabels.set(node.id, labels);
  }

  let changed = false;
  const labelled = edges.map((edge) => {
    const handle = edge.sourceHandle;
    const label =
      handle === null || handle === undefined || handle === ""
        ? undefined
        : branchLabels.get(edge.source)?.get(handle) || handle;
    if (edge.label === label) return edge;
    changed = true;
    return { ...edge, label };
  });
  return changed ? labelled : (edges as Edge[]);
}

/**
 * The edges the canvas can actually place.
 *
 * A conditional draws at most [`MAX_BRANCHES_PER_CONDITIONAL`] source handles (see
 * `ConditionalNode`), and React Flow cannot place an edge whose handle is not drawn — so
 * handing it 20,000 of them is 20,000 edge components for handles that do not exist, which is
 * half of why a wide document froze a real browser for 10.8 s on load.
 *
 * A **rendering** filter, exactly like [`withBranchLabels`]: it is applied to what the canvas
 * is given, never to the canvas state, so `flowToDocument` still sees every edge and saving an
 * over-wide document loses nothing. Contrast [`keepConnectedEdges`], which removes edges whose
 * branch is *gone* — those are undrawable for good, and dropping them is the point.
 *
 * Identity-stable when there is nothing to hide, so the common case allocates nothing.
 */
export function drawableEdges(
  nodes: readonly PatchNode[],
  edges: readonly Edge[],
): Edge[] {
  /** The branch ids each over-wide conditional actually draws. */
  let drawn: Map<string, Set<string>> | undefined;
  for (const node of nodes) {
    const branches = branchesOfFlowNode(node);
    if (branches.length <= MAX_BRANCHES_PER_CONDITIONAL) continue;
    drawn ??= new Map();
    drawn.set(
      node.id,
      new Set(branchesWithinLimit(branches).map((branch) => branch?.id)),
    );
  }
  if (drawn === undefined) return edges as Edge[];

  const placeable = edges.filter((edge) => {
    const visible = drawn?.get(edge.source);
    if (visible === undefined) return true;
    const handle = edge.sourceHandle;
    return handle !== null && handle !== undefined && visible.has(handle);
  });
  return placeable.length === edges.length ? (edges as Edge[]) : placeable;
}

/**
 * Keep only the edges the canvas can still own: both endpoints present, and — for a
 * conditional — a branch that still exists.
 *
 * Two rules, one pass, because both answer the same question and both have to be answered on
 * every change to the nodes:
 *
 * 1. **An endpoint that is gone.** React Flow works out which edges a deleted node owns from
 *    the `edges` prop it was **given**, and an over-wide conditional withholds the edges of the
 *    branches it does not draw ([`drawableEdges`]). So deleting such a node took its drawn
 *    edges and left the rest in state, pointing at a node that no longer existed — silent,
 *    written to disk by the next save, and impossible to repair in the app, since nothing draws
 *    an edge whose source is missing and so nothing can select it. One keystroke on a node the
 *    app had just refused to export. This rule is what makes the withholding safe: it holds for
 *    *any* way a node leaves the canvas, not just for the keystroke that found it.
 * 2. **A branch that is gone.** Removing a branch removes the path it named, and React Flow
 *    cannot draw an edge whose source handle is not there — so keeping it would leave an
 *    invisible edge that only surfaces as a validation error about a branch nobody can see.
 *
 * The cost of the second rule is that opening a hand-edited document whose edge names an unknown
 * branch loses that edge rather than reporting it; what remains is the *branch* it points at
 * being unwired, which validation reports and the canvas shows. The first rule has the same
 * shape for an edge naming a node that is not in the document at all. See ADR-0003.
 */
export function keepConnectedEdges(
  nodes: readonly PatchNode[],
  edges: readonly Edge[],
): Edge[] {
  const present = new Set<string>();
  const conditionals = new Map<string, Set<string>>();
  for (const node of nodes) {
    present.add(node.id);
    if (node.type !== "conditional") continue;
    conditionals.set(
      node.id,
      new Set(branchesOfFlowNode(node).map((branch) => branch?.id)),
    );
  }

  const kept = edges.filter((edge) => {
    if (!present.has(edge.source) || !present.has(edge.target)) return false;
    const branches = conditionals.get(edge.source);
    if (branches === undefined) return true;
    const handle = edge.sourceHandle;
    return handle !== null && handle !== undefined && branches.has(handle);
  });
  return kept.length === edges.length ? (edges as Edge[]) : kept;
}

/**
 * Re-run reference resolution over the canvas.
 *
 * Called whenever a document is opened or the roots are rescanned: a node whose
 * artifact has moved or been deleted is flagged rather than dropped, so a stale
 * reference can never cost the user their graph.
 */
export function applyResolution(
  nodes: readonly PatchNode[],
  catalog: ImportCatalog,
): PatchNode[] {
  let changed = false;
  const resolved = nodes.map((node) => {
    const kind = artifactKindOf(node.type as NodeType);
    if (!kind) return node;
    // Resolution is by kind+name only, deliberately: the stored `rootId` records
    // where the artifact came from when the document was saved, but precedence
    // re-runs against the roots configured *now*, so the winning root may
    // legitimately differ. Matching on rootId would defeat that contract.
    const { name } = node.data.node as ArtifactRefData;
    // An unbound node references nothing yet, so it cannot be *un*resolved — the
    // node body already says "no artifact bound". Flagging it here would also add
    // it to App's "reference an artifact that is not in any configured source
    // root" notice, which would be claiming a reference that does not exist.
    const unresolved = name !== "" && !findCatalogArtifact(catalog, kind, name);
    if (node.data.unresolved === unresolved) return node;
    changed = true;
    return { ...node, data: { ...node.data, unresolved } };
  });
  // Identity-stable when nothing moved, so React/React Flow can skip the update.
  return changed ? resolved : (nodes as PatchNode[]);
}

/** Rebuild a Patchwork document from the current canvas state. */
export function flowToDocument(
  nodes: PatchNode[],
  edges: Edge[],
  workflow: WorkflowMeta,
): PatchworkDocument {
  const conditionals = new Set(
    nodes.filter((n) => n.type === "conditional").map((n) => n.id),
  );
  const graphEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    // Only a conditional's edges carry a branch. Read off the source handle the
    // user drew from, and only for a conditional source, so a stray handle id on
    // any other node cannot end up in the document as a branch.
    ...(conditionals.has(e.source) && e.sourceHandle
      ? { branch: e.sourceHandle }
      : {}),
  }));

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as NodeType,
      label: n.data.label,
      data: n.data.node,
      position: { x: n.position.x, y: n.position.y },
    })),
    edges: graphEdges,
  };
}
