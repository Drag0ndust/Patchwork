import type { Edge, Node } from "@xyflow/react";
import {
  CURRENT_SCHEMA_VERSION,
  type GraphEdge,
  type NodeData,
  type NodeType,
  type PatchworkDocument,
  type WorkflowMeta,
} from "../domain/graph-document";

/** Data carried on each React Flow node. */
export interface PatchNodeData extends Record<string, unknown> {
  label: string;
  node: NodeData;
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
