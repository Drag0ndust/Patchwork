import type { Edge, Node } from "@xyflow/react";
import {
  CURRENT_SCHEMA_VERSION,
  artifactKindOf,
  type ArtifactRefData,
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
  return {
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position ?? { ...DEFAULT_POSITION },
      data: { label: n.label, node: n.data },
    })),
    edges: doc.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    })),
  };
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
    const unresolved = !findCatalogArtifact(catalog, kind, name);
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
  const graphEdges: GraphEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
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
