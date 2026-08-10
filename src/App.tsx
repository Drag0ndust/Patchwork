import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  applyResolution,
  documentToFlow,
  drawableEdges,
  flowToDocument,
  keepConnectedEdges,
  withBranchLabels,
  type PatchNode,
} from "./canvas/react-flow-adapter";
import { compile, vendorErrors } from "./domain/compiler";
import {
  DEFAULT_CONDITIONAL_MODE,
  DEFAULT_EXPORT_MODE,
  deserialize,
  serialize,
  validateGraph,
  type NodeData,
  type NodeType,
  type WorkflowMeta,
} from "./domain/graph-document";
import { newId } from "./domain/ids";
import type { RootRole } from "./domain/root-resolver";
import {
  describeCollisions,
  EMPTY_CATALOG,
  type ImportCatalog,
} from "./import/catalog";
import { scanSourceRoots } from "./import/scanner";
import {
  addSourceRoot,
  classifyAddSourceRoot,
  MAX_SOURCE_ROOTS,
  parseSourceRoots,
  removeSourceRoot,
  serializeSourceRoots,
  type AddRootOutcome,
  type SourceRoot,
} from "./import/source-roots";
import { NodeEditor, type NodeDataEdit } from "./editor/NodeEditor";
import {
  exportBundle,
  pickDocumentToOpen,
  pickDocumentToSave,
  pickExportDirectory,
  pickSourceRoot,
  readDocument,
  writeDocument,
} from "./bridge/tauri";

const ROOTS_STORAGE_KEY = "patchwork.sourceRoots";

function defaultData(type: NodeType): NodeData {
  switch (type) {
    case "input":
      return { parameters: [{ name: "input", description: "" }] };
    case "prompt":
      return { instruction: "" };
    case "output":
      return { description: "" };
    case "skill":
    case "agent":
      // Bound to an artifact by the picker in the dock editor. Reference-by-name
      // until the user asks for a copy — see `DEFAULT_EXPORT_MODE`.
      return { name: "", rootId: "", exportMode: DEFAULT_EXPORT_MODE };
    case "conditional":
      // Two branches, because one is not a choice and `validateGraph` refuses it —
      // a freshly placed conditional is wireable straight away. The labels are
      // starting points the user is expected to replace; they are what the exported
      // prose asks the model to choose between, so they must not be blank.
      return {
        mode: DEFAULT_CONDITIONAL_MODE,
        question: "",
        branches: [
          { id: newId("branch"), label: "yes" },
          { id: newId("branch"), label: "no" },
        ],
      };
  }
}

function defaultLabel(type: NodeType): string {
  return {
    input: "Input",
    prompt: "Prompt",
    output: "Output",
    skill: "Skill",
    agent: "Agent",
    conditional: "Conditional",
  }[type];
}

/** The raw stored configuration, or null if there is none or it is unreadable. */
function readStoredSourceRoots(): string | null {
  try {
    return localStorage.getItem(ROOTS_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Read the persisted root configuration; falls back to `~/.claude`. */
function loadSourceRoots(): SourceRoot[] {
  return parseSourceRoots(readStoredSourceRoots());
}

/**
 * What to tell the user about an attempted add.
 *
 * Every outcome gets a word, and the three no-ops say different things: a
 * refused root must never read as an accepted one, and "remove one first" would
 * be wrong advice for a root that is already configured.
 *
 * On the happy path the rescan the add triggers replaces this line within
 * milliseconds with its import summary — so it announces the scan rather than
 * looking like a confirmation that got cut off. The no-op cases trigger no
 * rescan, which is exactly when their explanation has to persist.
 */
function addRootStatus(outcome: AddRootOutcome, role: RootRole, path: string): string {
  switch (outcome) {
    case "added":
      return `Added ${role} source root '${path}' — scanning…`;
    case "duplicate":
      return `'${path}' is already a configured ${role} source root.`;
    case "at-capacity":
      return `Cannot add '${path}': at the limit of ${MAX_SOURCE_ROOTS} source roots. Remove one first.`;
    case "empty-path":
      return "Could not add source root: the chosen path is empty.";
  }
}

function persistSourceRoots(roots: SourceRoot[]): void {
  try {
    localStorage.setItem(ROOTS_STORAGE_KEY, serializeSourceRoots(roots));
  } catch {
    // Persistence is a convenience; a locked-down storage must not break editing.
  }
}

export function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<PatchNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workflowName, setWorkflowName] = useState("My Workflow");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [status, setStatus] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);
  const [sourceRoots, setSourceRoots] = useState<SourceRoot[]>(loadSourceRoots);
  const [catalog, setCatalog] = useState<ImportCatalog>(EMPTY_CATALOG);
  const [exporting, setExporting] = useState(false);
  const exportInFlight = useRef(false);

  const workflow: WorkflowMeta = useMemo(
    () => ({ name: workflowName, description: workflowDescription }),
    [workflowName, workflowDescription],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId) ?? null;

  /**
   * The catalog as of *now*, for async work that must not resolve references
   * against a catalog captured when it started — opening a document while the
   * first scan is still in flight would otherwise flag valid bindings unresolved
   * for good.
   */
  const catalogRef = useRef(catalog);
  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);

  /**
   * Which scan is current. Scans complete in arrival order, not issue order, so
   * a slow scan of roots the user has since changed must not clobber a newer
   * result (or repopulate the picker from a root that was just removed).
   */
  const scanGeneration = useRef(0);

  /**
   * Scan the configured roots and re-resolve every imported reference on the
   * canvas. Runs on start-up and whenever the roots change, so a moved artifact
   * shows up as unresolved instead of silently drifting.
   */
  const rescan = useCallback(
    async (roots: SourceRoot[]) => {
      scanGeneration.current += 1;
      const generation = scanGeneration.current;
      try {
        const scanned = await scanSourceRoots(roots);
        if (generation !== scanGeneration.current) return; // Superseded.
        setCatalog(scanned);
        const skills = scanned.artifacts.filter((a) => a.kind === "skill").length;
        const agents = scanned.artifacts.length - skills;
        setStatus(
          `Imported ${skills} skill(s) and ${agents} agent(s) from ${roots.length} source root(s).`,
        );
      } catch (e) {
        if (generation !== scanGeneration.current) return;
        setCatalog(EMPTY_CATALOG);
        setStatus(`Could not scan source roots: ${String(e)}`);
      }
    },
    [],
  );

  // Re-resolve whenever the catalog changes, so a late-arriving scan heals nodes
  // that were placed or loaded before it landed. `applyResolution` is
  // identity-stable, so this settles in one pass.
  useEffect(() => {
    setNodes((ns) => applyResolution(ns, catalog));
  }, [catalog, setNodes]);

  useEffect(() => {
    void rescan(sourceRoots);
  }, [rescan, sourceRoots]);

  // The configuration as of the last render, for async work that must not decide
  // from a list captured before it awaited.
  const rootsRef = useRef(sourceRoots);
  useEffect(() => {
    rootsRef.current = sourceRoots;
  }, [sourceRoots]);

  /**
   * Persist whatever the configuration settled on, rather than what any one
   * caller thought it would become — but never write back what was merely *read*.
   *
   * Mount would otherwise overwrite storage with whatever `parseSourceRoots` could
   * salvage, discarding roots beyond the cap and turning a hand-repairable
   * corrupted value into an unrecoverable one.
   *
   * The guard is **idempotent**, not first-run-gated: it compares the serialized
   * configuration against the last one written, seeded with the configuration as
   * *hydrated*, instead of counting effect invocations. StrictMode double-invokes
   * mount effects in development and a "have I run yet" flag survives that
   * double-invoke — so a counting guard would perform precisely the write it exists
   * to prevent, in dev only, in a data-preservation path. Comparing values holds
   * for any number of invocations.
   */
  // Only the value from the first render is retained; the rest are discarded.
  const lastPersisted = useRef(serializeSourceRoots(sourceRoots));
  useEffect(() => {
    const serialized = serializeSourceRoots(sourceRoots);
    if (serialized === lastPersisted.current) return;
    persistSourceRoots(sourceRoots);
    lastPersisted.current = serialized;
  }, [sourceRoots]);

  const handleAddRoot = useCallback(
    async (role: RootRole) => {
      try {
        const path = await pickSourceRoot();
        if (!path) return;
        // Functional update: the picker is async, so the configuration may have
        // changed while it was open. Adding to a captured list would silently
        // resurrect a root the user removed in the meantime.
        setSourceRoots((prev) => addSourceRoot(prev, path, role));
        // Every add needs a word, and the three ways an add can do nothing are
        // not interchangeable — a refused root must not read as an accepted one.
        // `rootsRef` is the configuration as of the last render, the same list
        // the updater above starts from.
        setStatus(
          addRootStatus(classifyAddSourceRoot(rootsRef.current, path, role), role, path),
        );
      } catch (e) {
        setStatus(`Could not add source root: ${String(e)}`);
      }
    },
    [],
  );

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
    (id: string, label: string, data: NodeDataEdit) => {
      // Re-resolve so binding a reference clears (or sets) its unresolved flag.
      setNodes((ns) =>
        applyResolution(
          ns.map((n) => {
            if (n.id !== id) return n;
            // An editor may send an update instead of a value, to change one field
            // without carrying a possibly-stale copy of the others — resolve it
            // against the node as it is *now*, inside the functional update.
            const node =
              typeof data === "function" ? data(n.data.node) : data;
            return { ...n, data: { ...n.data, label, node } };
          }),
          catalogRef.current,
        ),
      );
    },
    [setNodes],
  );

  /**
   * What the canvas is given: the edges it can place, labelled with the branch each one leaves
   * its source by.
   *
   * Both passes are derived on render rather than stored. The label belongs to the node's
   * branch, so renaming one re-labels its edges without the edge list being edited (the
   * document keeps only the branch id — see ADR-0003); and an over-wide conditional draws only
   * as many handles as it can, so the edges of the branches it did not draw cannot be placed
   * and are not handed over. Neither pass touches `edges` state, which is what a save writes —
   * opening an over-wide document and saving it must not lose the branches it holds. Both are
   * identity-stable, so the common case allocates nothing.
   */
  const canvasEdges = useMemo(
    () => withBranchLabels(nodes, drawableEdges(nodes, edges)),
    [nodes, edges],
  );

  // An edge cannot outlive what it joins. Removing a branch removes the path it named, and
  // removing a *node* removes every edge that touched it — React Flow does the second one
  // itself, but only for the edges it was given, and an over-wide conditional withholds the
  // ones it cannot draw. So the canvas state is reconciled here, on every change to the nodes,
  // which is when either can happen (including on load, and for any future way of removing a
  // node). `keepConnectedEdges` returns the same array when there is nothing to prune, so this
  // settles in one pass and never loops.
  useEffect(() => {
    setEdges((eds) => keepConnectedEdges(nodes, eds));
  }, [nodes, setEdges]);

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
      setNodes(applyResolution(flow.nodes, catalogRef.current));
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
    // One export at a time. Not for the bundle's sake — the Bundle Emitter stages
    // and swaps, so overlapping exports cannot damage each other's output on disk
    // (the loser's rename fails cleanly; see ADR-0002) — but for the sake of what
    // this handler *reports*. Two exports in flight means two directory pickers and
    // two status lines racing to describe one button press, and the user would have
    // no way to tell which "Exported bundle to …" belongs to which click.
    //
    // Enforced on a ref rather than on `exporting`, because two clicks in one tick
    // see the same rendered state.
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setExporting(true);
    // Everything, validation included, runs inside the try: this handler is
    // async, so anything thrown outside it becomes an unhandled rejection and the
    // click appears to do nothing at all.
    try {
      const doc = currentDocument();
      const validation = validateGraph(doc);
      if (!validation.ok) {
        setErrors(validation.errors);
        setStatus("Cannot export: fix validation errors first.");
        return;
      }
      // The bytes a vendor-copy node needs, captured once so the export writes
      // exactly the artifacts that were just checked — a scan landing while the
      // directory picker is open must not change what gets copied.
      const artifacts = catalogRef.current.artifacts.map((a) => a.artifact);
      const unvendorable = vendorErrors(doc, artifacts);
      if (unvendorable.length > 0) {
        setErrors(unvendorable);
        setStatus(
          "Cannot export: a node is set to copy an artifact that is not available right now.",
        );
        return;
      }
      setErrors([]);
      const dir = await pickExportDirectory();
      if (!dir) return;
      const written = await exportBundle(compile(doc, artifacts), dir);
      setStatus(`Exported bundle to ${written}`);
    } catch (e) {
      setStatus(`Export failed: ${String(e)}`);
    } finally {
      // Released on every path out — a cancelled picker, a validation refusal, or
      // a failed write must not leave the button dead for the rest of the session.
      exportInFlight.current = false;
      setExporting(false);
    }
  }, [currentDocument]);

  const unresolvedCount = nodes.filter((n) => n.data.unresolved).length;
  const notices = [
    ...describeCollisions(catalog.collisions),
    ...catalog.problems,
    ...(unresolvedCount > 0
      ? [
          // The consequence differs per node now: naming an artifact never needs
          // its bytes, copying one does — so a single sentence would be wrong for
          // half of them.
          `${unresolvedCount} node(s) reference an artifact that is not in any configured source root; reference-by-name nodes still export, while a node set to copy its artifact will refuse to.`,
        ]
      : []),
  ];

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
          <button onClick={() => addNode("conditional")}>＋ Conditional</button>
          <button onClick={() => addNode("skill")}>＋ Skill</button>
          <button onClick={() => addNode("agent")}>＋ Agent</button>
          <button onClick={() => addNode("output")}>＋ Output</button>
        </div>
        <div className="pw-toolbar__group pw-toolbar__group--end">
          <button onClick={handleSave}>Save</button>
          <button onClick={handleLoad}>Load</button>
          <button className="pw-primary" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export"}
          </button>
        </div>
      </header>

      <div className="pw-roots">
        <span className="pw-roots__title">Source roots</span>
        <ul className="pw-roots__list">
          {sourceRoots.map((root) => (
            <li key={root.id} className="pw-roots__item">
              <code>{root.path}</code>
              <span className="pw-roots__role">{root.role}</span>
              <button
                aria-label={`Remove source root ${root.path}`}
                onClick={() =>
                  setSourceRoots((prev) => removeSourceRoot(prev, root.id))
                }
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <div className="pw-toolbar__group pw-toolbar__group--end">
          <button onClick={() => handleAddRoot("personal")}>＋ Personal root…</button>
          <button onClick={() => handleAddRoot("project")}>＋ Project root…</button>
          <button onClick={() => void rescan(sourceRoots)}>Rescan</button>
        </div>
      </div>

      <div className="pw-canvas">
        <ReactFlow
          nodes={nodes}
          edges={canvasEdges}
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
        // Labelled because the page has several lists (source roots, notices) and
        // "the errors" has to be nameable — by a screen reader reaching it out of
        // order, and by a test asserting on what the user was told.
        <ul className="pw-errors" aria-label="Validation errors">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      {notices.length > 0 && (
        <ul className="pw-notices">
          {notices.map((notice, index) => (
            <li key={`${index}:${notice}`}>{notice}</li>
          ))}
        </ul>
      )}

      <NodeEditor node={selectedNode} catalog={catalog} onChange={updateNode} />

      {status && <footer className="pw-status">{status}</footer>}
    </div>
  );
}
