import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, type PatchworkDocument } from "../domain/graph-document";
import { buildCatalog, type ImportCatalog } from "../import/catalog";
import {
  applyResolution,
  documentToFlow,
  flowToDocument,
} from "./react-flow-adapter";

function doc(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Round Trip", description: "d" },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic", description: "subject" }] },
        position: { x: 10, y: 20 },
      },
      {
        id: "n2",
        type: "output",
        label: "Result",
        data: { description: "the answer" },
        position: { x: 300, y: 20 },
      },
    ],
    edges: [{ id: "e1", source: "n1", target: "n2" }],
  };
}

describe("react-flow-adapter", () => {
  it("given_document_whenRoundTrippedThroughFlow_thenPreservesSchema", () => {
    const original = doc();
    const flow = documentToFlow(original);
    const restored = flowToDocument(flow.nodes, flow.edges, original.workflow);
    expect(restored).toEqual(original);
  });

  it("given_documentNode_whenConverted_thenFlowNodeCarriesLabelAndData", () => {
    const flow = documentToFlow(doc());
    const inputNode = flow.nodes.find((n) => n.id === "n1");
    expect(inputNode?.type).toBe("input");
    expect(inputNode?.data.label).toBe("Topic");
    expect(inputNode?.position).toEqual({ x: 10, y: 20 });
  });
});

/** A canvas holding one imported skill node and one imported agent node. */
function refFlow() {
  return documentToFlow({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Refs", description: "d" },
    nodes: [
      { id: "n1", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      { id: "n2", type: "skill", label: "TDD", data: { name: "tdd", rootId: "personal:~/.claude" } },
      {
        id: "n3",
        type: "agent",
        label: "Reviewer",
        data: { name: "reviewer", rootId: "personal:~/.claude" },
      },
    ],
    edges: [],
  });
}

function catalogWith(kinds: Array<["skill" | "agent", string]>): ImportCatalog {
  return buildCatalog(
    [{ id: "personal:~/.claude", path: "~/.claude", role: "personal" }],
    {
      artifacts: kinds.map(([kind, name]) => ({
        rootId: "personal:~/.claude",
        kind,
        name,
        path: `~/.claude/${kind}s/${name}`,
        contents: `---\nname: ${name}\ndescription: An artifact.\n---\n\nBody.\n`,
      })),
      problems: [],
    },
  );
}

describe("applyResolution", () => {
  it("given_refNodesWhoseArtifactsExist_whenResolved_thenNoneAreFlagged", () => {
    const resolved = applyResolution(
      refFlow().nodes,
      catalogWith([
        ["skill", "tdd"],
        ["agent", "reviewer"],
      ]),
    );

    expect(resolved.map((n) => n.data.unresolved)).toEqual([
      undefined,
      false,
      false,
    ]);
  });

  it("given_refToAnAbsentArtifact_whenResolved_thenOnlyThatNodeIsFlaggedUnresolved", () => {
    const resolved = applyResolution(refFlow().nodes, catalogWith([["skill", "tdd"]]));

    expect(resolved[1].data.unresolved).toBe(false);
    expect(resolved[2].data.unresolved).toBe(true);
    expect(resolved[2].data.node).toEqual({
      name: "reviewer",
      rootId: "personal:~/.claude",
    });
  });

  it("given_artifactOfTheOtherKindWithTheSameName_whenResolved_thenTheNodeStaysUnresolved", () => {
    const resolved = applyResolution(refFlow().nodes, catalogWith([["agent", "tdd"]]));

    expect(resolved[1].data.unresolved).toBe(true);
  });

  it("given_resolvedCanvas_whenConvertedBackToADocument_thenTheFlagIsNotPersisted", () => {
    const flow = refFlow();
    const resolved = applyResolution(flow.nodes, catalogWith([]));

    const doc = flowToDocument(resolved, flow.edges, {
      name: "Refs",
      description: "d",
    });

    expect(doc.nodes[1].data).toEqual({ name: "tdd", rootId: "personal:~/.claude" });
    expect(JSON.stringify(doc)).not.toContain("unresolved");
  });

  it("given_nothingToChange_whenResolvedAgain_thenTheSameArrayIsReturned", () => {
    // Identity-stability is load-bearing: App re-runs resolution in an effect
    // keyed on the catalog, and a fresh array every time would re-render the
    // canvas (and, when that effect also depended on the nodes, loop).
    const catalog = catalogWith([
      ["skill", "tdd"],
      ["agent", "reviewer"],
    ]);
    const resolved = applyResolution(refFlow().nodes, catalog);

    expect(applyResolution(resolved, catalog)).toBe(resolved);
  });

  it("given_somethingToChange_whenResolved_thenANewArrayIsReturned", () => {
    const nodes = refFlow().nodes;

    expect(applyResolution(nodes, catalogWith([]))).not.toBe(nodes);
  });

  it("given_unboundRefNodeFromTheToolbar_whenResolved_thenItIsNotFlaggedUnresolved", () => {
    // A node with no artifact bound references nothing, so it must not read as a
    // broken reference — on the node body, or in App's unresolved-count notice.
    const nodes = unboundFlow().nodes;

    const resolved = applyResolution(nodes, catalogWith([["skill", "tdd"]]));

    expect(resolved.map((n) => n.data.unresolved)).toEqual([false, false]);
  });

  it("given_unboundRefNodes_whenResolvedAgainstAnEmptyCatalog_thenNoneAreFlagged", () => {
    const resolved = applyResolution(unboundFlow().nodes, catalogWith([]));

    expect(resolved.some((n) => n.data.unresolved)).toBe(false);
  });

  it("given_unboundRefNode_whenBoundToAnAbsentArtifact_thenItBecomesUnresolved", () => {
    const bound = unboundFlow().nodes.map((n) => ({
      ...n,
      data: { ...n.data, node: { name: "gone", rootId: "" } },
    }));

    const resolved = applyResolution(bound, catalogWith([]));

    expect(resolved.map((n) => n.data.unresolved)).toEqual([true, true]);
  });
});

/** A canvas holding freshly-added skill/agent nodes, with no artifact bound yet. */
function unboundFlow() {
  return documentToFlow({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Unbound", description: "d" },
    nodes: [
      { id: "n1", type: "skill", label: "Skill", data: { name: "", rootId: "" } },
      { id: "n2", type: "agent", label: "Agent", data: { name: "", rootId: "" } },
    ],
    edges: [],
  });
}
