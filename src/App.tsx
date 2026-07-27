import { useCallback, useMemo, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import { nodeTypes } from "./canvas/nodes";
import {
  documentToFlow,
  flowToDocument,
  type PatchNode,
} from "./canvas/react-flow-adapter";
import { compile } from "./domain/compiler";
import {
  deserialize,
  serialize,
  validateGraph,
  type NodeData,
  type NodeType,
  type WorkflowMeta,
} from "./domain/graph-document";
import { NodeEditor } from "./editor/NodeEditor";
import {
  exportBundle,
  pickDocumentToOpen,
  pickDocumentToSave,
  pickExportDirectory,
  readDocument,
  writeDocument,
} from "./bridge/tauri";

let idCounter = 0;
function newId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function defaultData(type: NodeType): NodeData {
  switch (type) {
    case "input":
      return { parameters: [{ name: "input", description: "" }] };
    case "prompt":
      return { instruction: "" };
    case "output":
      return { description: "" };
  }
}

function defaultLabel(type: NodeType): string {
  return { input: "Input", prompt: "Prompt", output: "Output" }[type];
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<PatchNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState("My Workflow");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [status, setStatus] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);

  const workflow: WorkflowMeta = useMemo(
    () => ({ name: workflowName, description: workflowDescription }),
    [workflowName, workflowDescription],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge(connection, eds)),
    [setEdges],
  );

  const onSelectionChange = useCallback(
    ({ nodes: selected }: OnSelectionChangeParams) => {
      setSelectedId(selected.length === 1 ? selected[0].id : null);
    },
    [],
  );

  const addNode = useCallback(
    (type: NodeType) => {
      const node: PatchNode = {
        id: newId(type),
        type,
        position: { x: 120 + nodes.length * 60, y: 120 + nodes.length * 40 },
        data: { label: defaultLabel(type), node: defaultData(type) },
      };
      setNodes((ns) => [...ns, node]);
    },
    [nodes.length, setNodes],
  );

  const updateNode = useCallback(
    (id: string, label: string, data: NodeData) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id ? { ...n, data: { label, node: data } } : n,
        ),
      );
    },
    [setNodes],
  );

  const currentDocument = useCallback(
    () => flowToDocument(nodes, edges, workflow),
    [nodes, edges, workflow],
  );

  const handleSave = useCallback(async () => {
    try {
      const path = await pickDocumentToSave(workflowName);
      if (!path) return;
      await writeDocument(path, serialize(currentDocument()));
      setStatus(`Saved to ${path}`);
    } catch (e) {
      setStatus(`Save failed: ${String(e)}`);
    }
  }, [currentDocument, workflowName]);

  const handleLoad = useCallback(async () => {
    try {
      const path = await pickDocumentToOpen();
      if (!path) return;
      const doc = deserialize(await readDocument(path));
      const flow = documentToFlow(doc);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setWorkflowName(doc.workflow.name);
      setWorkflowDescription(doc.workflow.description ?? "");
      setSelectedId(null);
      setErrors([]);
      setStatus(`Loaded ${path}`);
    } catch (e) {
      setStatus(`Load failed: ${String(e)}`);
    }
  }, [setNodes, setEdges]);

  const handleExport = useCallback(async () => {
    const doc = currentDocument();
    const validation = validateGraph(doc);
    if (!validation.ok) {
      setErrors(validation.errors);
      setStatus("Cannot export: fix validation errors first.");
      return;
    }
    setErrors([]);
    try {
      const dir = await pickExportDirectory();
      if (!dir) return;
      const written = await exportBundle(compile(doc), dir);
      setStatus(`Exported bundle to ${written}`);
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    }
  }, [currentDocument]);

  return (
    <div className="pw-app">
      <header className="pw-toolbar">
        <span className="pw-brand">Patchwork</span>
        <input
          className="pw-workflow-name"
          value={workflowName}
          onChange={(e) => setWorkflowName(e.target.value)}
          aria-label="Workflow name"
          placeholder="Workflow name"
        />
        <input
          className="pw-workflow-description"
          value={workflowDescription}
          onChange={(e) => setWorkflowDescription(e.target.value)}
          aria-label="Workflow description"
          placeholder="Description (used to discover the skill)"
        />
        <div className="pw-toolbar__group">
          <button onClick={() => addNode("input")}>＋ Input</button>
          <button onClick={() => addNode("prompt")}>＋ Prompt</button>
          <button onClick={() => addNode("output")}>＋ Output</button>
        </div>
        <div className="pw-toolbar__group pw-toolbar__group--end">
          <button onClick={handleSave}>Save</button>
          <button onClick={handleLoad}>Load</button>
          <button className="pw-primary" onClick={handleExport}>
            Export
          </button>
        </div>
      </header>

      <div className="pw-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onSelectionChange={onSelectionChange}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {errors.length > 0 && (
        <ul className="pw-errors">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      <NodeEditor node={selectedNode} onChange={updateNode} />

      {status && <footer className="pw-status">{status}</footer>}
    </div>
  );
}
