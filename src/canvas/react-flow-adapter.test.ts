import { describe, expect, it } from "vitest";
import {
  branchesWithinLimit,
  CURRENT_SCHEMA_VERSION,
  MAX_BRANCHES_PER_CONDITIONAL,
  type PatchworkDocument,
} from "../domain/graph-document";
import { buildCatalog, type ImportCatalog } from "../import/catalog";
import {
  applyResolution,
  documentToFlow,
  drawableEdges,
  flowToDocument,
  keepConnectedEdges,
  withBranchLabels,
  withInputLabels,
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

/** A canvas with one conditional whose two branches are wired to two prompts. */
function conditionalDoc(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Branching", description: "d" },
    nodes: [
      {
        id: "i",
        type: "input",
        label: "In",
        data: { parameters: [{ name: "x" }] },
        position: { x: 0, y: 0 },
      },
      {
        id: "c",
        type: "conditional",
        label: "Which way?",
        data: {
          mode: "llm",
          question: "Which way?",
          branches: [
            { id: "b1", label: "quick" },
            { id: "b2", label: "thorough" },
          ],
        },
        position: { x: 200, y: 0 },
      },
      {
        id: "p1",
        type: "prompt",
        label: "Quick",
        data: { instruction: "quick" },
        position: { x: 400, y: -60 },
      },
      {
        id: "p2",
        type: "prompt",
        label: "Thorough",
        data: { instruction: "slow" },
        position: { x: 400, y: 60 },
      },
    ],
    edges: [
      { id: "e1", source: "i", target: "c" },
      { id: "e2", source: "c", target: "p1", branch: "b1" },
      { id: "e3", source: "c", target: "p2", branch: "b2" },
    ],
  };
}

describe("react-flow-adapter — branch labels on a conditional's edges", () => {
  it("given_aConditionalDocument_whenRoundTrippedThroughFlow_thenTheBranchOfEachEdgeSurvives", () => {
    const original = conditionalDoc();
    const flow = documentToFlow(original);

    expect(flowToDocument(flow.nodes, flow.edges, original.workflow)).toEqual(original);
  });

  it("given_aBranchEdge_whenConverted_thenItLeavesTheMatchingSourceHandle", () => {
    // The handle is how the user draws the branch, and it is the *rendering* of the
    // document's `branch` field — never a second source of truth.
    const flow = documentToFlow(conditionalDoc());

    expect(flow.edges.map((e) => [e.id, e.sourceHandle])).toEqual([
      ["e1", undefined],
      ["e2", "b1"],
      ["e3", "b2"],
    ]);
  });

  it("given_aBranchEdge_whenConverted_thenItIsLabelledWithTheBranchLabel", () => {
    const flow = documentToFlow(conditionalDoc());

    expect(flow.edges.map((e) => e.label)).toEqual([undefined, "quick", "thorough"]);
  });

  it("given_aRenamedBranch_whenLabelsAreReapplied_thenTheEdgeLabelFollowsTheNode", () => {
    // The label lives on the branch, so an edge shows whatever the branch is called
    // *now* — renaming one must not need the edge list to be touched.
    const flow = documentToFlow(conditionalDoc());
    const renamed = flow.nodes.map((n) =>
      n.id === "c"
        ? {
            ...n,
            data: {
              ...n.data,
              node: {
                mode: "llm" as const,
                question: "Which way?",
                branches: [
                  { id: "b1", label: "fast" },
                  { id: "b2", label: "thorough" },
                ],
              },
            },
          }
        : n,
    );

    expect(withBranchLabels(renamed, flow.edges).map((e) => e.label)).toEqual([
      undefined,
      "fast",
      "thorough",
    ]);
  });

  it("given_anEdgeOnABranchThatNoLongerExists_whenLabelled_thenTheRawBranchIsShown", () => {
    // Better than an unlabelled edge: the canvas shows what the edge claims, and
    // `validateGraph` explains that the node does not offer it.
    const flow = documentToFlow(conditionalDoc());
    const edges = flow.edges.map((e) => (e.id === "e2" ? { ...e, sourceHandle: "gone" } : e));

    expect(withBranchLabels(flow.nodes, edges)[1].label).toBe("gone");
  });

  it("given_nothingToChange_whenLabelledAgain_thenTheSameArrayIsReturned", () => {
    // Identity-stability matters for the same reason it does in `applyResolution`:
    // App derives the rendered edges on every render.
    const flow = documentToFlow(conditionalDoc());

    expect(withBranchLabels(flow.nodes, flow.edges)).toBe(flow.edges);
  });
});

describe("keepConnectedEdges — a removed branch takes its edge with it", () => {
  it("given_aBranchRemovedFromTheNode_whenPruned_thenItsEdgeIsDropped", () => {
    const flow = documentToFlow(conditionalDoc());
    const withoutSecondBranch = flow.nodes.map((n) =>
      n.id === "c"
        ? {
            ...n,
            data: {
              ...n.data,
              node: {
                mode: "llm" as const,
                question: "Which way?",
                branches: [{ id: "b1", label: "quick" }],
              },
            },
          }
        : n,
    );

    expect(keepConnectedEdges(withoutSecondBranch, flow.edges).map((e) => e.id)).toEqual([
      "e1",
      "e2",
    ]);
  });

  it("given_everyBranchStillPresent_whenPruned_thenTheSameArrayIsReturned", () => {
    const flow = documentToFlow(conditionalDoc());

    expect(keepConnectedEdges(flow.nodes, flow.edges)).toBe(flow.edges);
  });

  it("given_anEdgeLeavingSomethingOtherThanAConditional_whenPruned_thenItIsKept", () => {
    const flow = documentToFlow(conditionalDoc());
    const edges = [...flow.edges, { id: "e4", source: "p1", target: "p2" }];

    expect(keepConnectedEdges(flow.nodes, edges).map((e) => e.id)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
  });
});

describe("withBranchLabels — one node's branch cannot borrow another's label", () => {
  it("given_branchIdsThatCollideUnderASpaceJoinedKey_whenLabelled_thenEachEdgeShowsItsOwnBranch", () => {
    // Node `n1` with branch `x y` and node `n1 x` with branch `y` both hashed to
    // `"n1 x y"`, so one edge was labelled with the other node's branch. Only reachable
    // from a hand-edited document, which is where a canvas has to stay truthful.
    const flow = documentToFlow({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Colliding", description: "d" },
      nodes: [
        {
          id: "n1",
          type: "conditional",
          label: "First",
          data: {
            mode: "llm",
            question: "First?",
            branches: [
              { id: "x y", label: "alpha" },
              { id: "z", label: "beta" },
            ],
          },
        },
        {
          id: "n1 x",
          type: "conditional",
          label: "Second",
          data: {
            mode: "llm",
            question: "Second?",
            branches: [
              { id: "y", label: "gamma" },
              { id: "w", label: "delta" },
            ],
          },
        },
        { id: "m", type: "prompt", label: "M", data: { instruction: "m" } },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n1 x", branch: "x y" },
        { id: "e2", source: "n1 x", target: "m", branch: "y" },
      ],
    });

    expect(flow.edges.map((e) => e.label)).toEqual(["alpha", "gamma"]);
  });
});

describe("drawableEdges — the canvas is not handed edges it cannot place", () => {
  /** One conditional with `branches` ways out, every one of them wired to the same node. */
  function wideFlow(branches: number) {
    return documentToFlow({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Wide", description: "d" },
      nodes: [
        {
          id: "c",
          type: "conditional",
          label: "Which?",
          data: {
            mode: "llm",
            question: "Which one?",
            branches: Array.from({ length: branches }, (_, at) => ({
              id: `b${at}`,
              label: `branch ${at}`,
            })),
          },
        },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
      ],
      edges: Array.from({ length: branches }, (_, at) => ({
        id: `e${at}`,
        source: "c",
        target: "p",
        branch: `b${at}`,
      })),
    });
  }

  it("given_everyBranchDrawn_whenAskedWhatToDraw_thenTheSameArrayIsReturned", () => {
    const flow = wideFlow(3);

    expect(drawableEdges(flow.nodes, flow.edges)).toBe(flow.edges);
  });

  it("given_moreBranchesThanAreDrawn_whenAskedWhatToDraw_thenOnlyTheDrawnOnesAreIncluded", () => {
    // A node draws at most `MAX_BRANCHES_PER_CONDITIONAL` source handles, and React Flow
    // cannot place an edge whose handle is not there — 20,000 of them froze a real browser on
    // load. This is a *rendering* filter: the document keeps every edge (see the next test),
    // so nothing is lost by opening a wide document and saving it again.
    const flow = wideFlow(5_000);

    const drawable = drawableEdges(flow.nodes, flow.edges);

    expect(drawable).toHaveLength(MAX_BRANCHES_PER_CONDITIONAL);
    expect(drawable.map((e) => e.id)).toEqual(
      Array.from({ length: MAX_BRANCHES_PER_CONDITIONAL }, (_, at) => `e${at}`),
    );
  });

  it("given_moreBranchesThanAreDrawn_whenAskedWhatToDraw_thenTheKeptEdgesNameTheBranchesEverySurfaceShows", () => {
    // The edge filter's half of the three-way agreement, against the one definition the canvas
    // node and the dock's rows also use.
    const branches = Array.from({ length: 5_000 }, (_, at) => ({
      id: `b${at}`,
      label: `branch ${at}`,
    }));
    const flow = wideFlow(5_000);

    expect(drawableEdges(flow.nodes, flow.edges).map((edge) => edge.sourceHandle)).toEqual(
      branchesWithinLimit(branches).map((branch) => branch.id),
    );
  });

  it("given_aWideConditional_whenTheDocumentIsRebuilt_thenEveryEdgeIsStillThere", () => {
    // The filter must never reach the document: `flowToDocument` is what a save writes.
    const flow = wideFlow(5_000);

    const doc = flowToDocument(flow.nodes, flow.edges, { name: "Wide", description: "d" });

    expect(doc.edges).toHaveLength(5_000);
    expect(doc.nodes[0].data).toEqual({
      mode: "llm",
      question: "Which one?",
      branches: expect.any(Array),
    });
  });

  it("given_edgesLeavingSomethingOtherThanAWideConditional_whenAskedWhatToDraw_thenTheyAreKept", () => {
    const flow = documentToFlow({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Plain", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
      ],
      edges: [{ id: "e1", source: "i", target: "p" }],
    });

    expect(drawableEdges(flow.nodes, flow.edges)).toBe(flow.edges);
  });
});

describe("keepConnectedEdges — an edge cannot outlive the nodes it joins", () => {
  /** A conditional with `branches` ways out, all wired to `p`, plus `in -> c`. */
  function wideFlow(branches: number) {
    return documentToFlow({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Wide", description: "d" },
      nodes: [
        { id: "in", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        {
          id: "c",
          type: "conditional",
          label: "Which?",
          data: {
            mode: "llm",
            question: "Which one?",
            branches: Array.from({ length: branches }, (_, at) => ({
              id: `b${at}`,
              label: `branch ${at}`,
            })),
          },
        },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
      ],
      edges: [
        { id: "e-in", source: "in", target: "c" },
        ...Array.from({ length: branches }, (_, at) => ({
          id: `e${at}`,
          source: "c",
          target: "p",
          branch: `b${at}`,
        })),
      ],
    });
  }

  it("given_anOverWideConditionalRemovedFromTheNodes_whenPruned_thenEveryOneOfItsEdgesGoes", () => {
    // React Flow works out which edges a deleted node owns from the edges it was *given*, and
    // an over-wide conditional withholds the ones it cannot draw (`drawableEdges`) — so
    // deleting the node left those behind, pointing at a node that no longer exists, and a
    // save wrote them to disk. Nothing draws such an edge, so nothing could delete it either.
    const flow = wideFlow(70);
    const withoutConditional = flow.nodes.filter((node) => node.id !== "c");

    const kept = keepConnectedEdges(withoutConditional, flow.edges);

    // Nothing survives: the 70 branch edges left it, and `in -> c` arrived at it.
    expect(kept).toEqual([]);
  });

  it("given_anOrdinaryNodeRemoved_whenPruned_thenOnlyTheEdgesThatTouchedItGo", () => {
    const flow = wideFlow(3);
    const withoutPrompt = flow.nodes.filter((node) => node.id !== "p");

    expect(keepConnectedEdges(withoutPrompt, flow.edges).map((edge) => edge.id)).toEqual([
      "e-in",
    ]);
  });

  it("given_everyEndpointStillPresent_whenPruned_thenTheSameArrayIsReturned", () => {
    // Including the case that matters for deleting an edge *directly*: an edge whose endpoints
    // both exist is never this function's business.
    const flow = wideFlow(70);

    expect(keepConnectedEdges(flow.nodes, flow.edges)).toBe(flow.edges);
  });

  it("given_aBranchRemovedFromItsNode_whenPruned_thenItsEdgeStillGoes", () => {
    // The rule this function had first, kept: a branch that no longer exists cannot keep an
    // edge attached to a handle nobody draws.
    const flow = wideFlow(3);
    const narrowed = flow.nodes.map((node) =>
      node.id === "c"
        ? {
            ...node,
            data: {
              ...node.data,
              node: {
                mode: "llm" as const,
                question: "Which one?",
                branches: [
                  { id: "b0", label: "branch 0" },
                  { id: "b1", label: "branch 1" },
                ],
              },
            },
          }
        : node,
    );

    expect(keepConnectedEdges(narrowed, flow.edges).map((edge) => edge.id)).toEqual([
      "e-in",
      "e0",
      "e1",
    ]);
  });

  it("given_severalNodesRemovedAtOnce_whenPruned_thenEveryEdgeThatTouchedAnyOfThemGoes", () => {
    // Multi-select delete, at the level the reconciliation happens: the effect runs once per
    // change to the nodes, so what matters is the *transition*, not how many keystrokes made it.
    // (Driving React Flow's rubber-band selection in a real browser proved too brittle to build
    // a suite on; the single-node case is covered end to end in `tests/e2e/export.spec.ts`.)
    const flow = wideFlow(70);
    const emptied = flow.nodes.filter((node) => node.id === "in");

    expect(keepConnectedEdges(emptied, flow.edges)).toEqual([]);
  });
});

describe("the canvas adapter — a branch entry that is not a branch", () => {
  /** The same hostile shape the domain tolerates: `branches: [null, {...}]`. */
  function flowWithANullBranch() {
    return documentToFlow({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Hostile", description: "d" },
      nodes: [
        {
          id: "c",
          type: "conditional",
          label: "C",
          data: {
            mode: "llm",
            question: "Which?",
            branches: [null, { id: "b", label: "labelled" }] as unknown as Array<{
              id: string;
              label: string;
            }>,
          },
        },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
      ],
      edges: [{ id: "e1", source: "c", target: "p", branch: "b" }],
    });
  }

  it("given_aNullBranchEntry_whenMappedToTheCanvas_thenNothingThrowsAndTheRealBranchIsLabelled", () => {
    // `deserialize` rejects this shape, so it cannot arrive through a file; the guard is here
    // because these functions are the ones a caller can reach with a hand-built document.
    const flow = flowWithANullBranch();

    expect(flow.edges[0].label).toBe("labelled");
    expect(drawableEdges(flow.nodes, flow.edges)).toBe(flow.edges);
    expect(keepConnectedEdges(flow.nodes, flow.edges)).toBe(flow.edges);
  });
});

/**
 * A canvas where two paths fan into one node:
 *
 * ```
 * n1 -> draft    -\
 *   \-> research -+-> merge
 * ```
 */
function fanInDoc(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Fan in", description: "d" },
    nodes: [
      {
        id: "n1",
        type: "input",
        label: "Topic",
        data: { parameters: [{ name: "topic" }] },
      },
      { id: "draft", type: "prompt", label: "Draft", data: { instruction: "d" } },
      { id: "research", type: "prompt", label: "Research", data: { instruction: "r" } },
      { id: "merge", type: "prompt", label: "Merge", data: { instruction: "m" } },
    ],
    edges: [
      { id: "e1", source: "n1", target: "draft" },
      { id: "e2", source: "n1", target: "research" },
      { id: "e3", source: "draft", target: "merge" },
      { id: "e4", source: "research", target: "merge" },
    ],
  };
}

describe("withInputLabels — a fan-in says on the canvas what each path carries", () => {
  it("given_twoPathsIntoOneNode_whenLabelled_thenEachEdgeShowsWhatItCarries", () => {
    const flow = documentToFlow(fanInDoc());

    const labelled = withInputLabels(flow.nodes, flow.edges);

    expect(labelled.find((e) => e.id === "e3")?.label).toBe("Draft");
    expect(labelled.find((e) => e.id === "e4")?.label).toBe("Research");
  });

  it("given_aSinglePathIntoANode_whenLabelled_thenItsEdgeIsLeftAlone", () => {
    // One input needs no name: the step's own instruction already says what it works
    // from, and a label per edge would be noise on every graph that does not fan in.
    const flow = documentToFlow(fanInDoc());

    const labelled = withInputLabels(flow.nodes, flow.edges);

    expect(labelled.find((e) => e.id === "e1")?.label).toBeUndefined();
    expect(labelled).toBe(withInputLabels(flow.nodes, labelled));
  });

  it("given_anEdgeWithItsOwnInputLabel_whenLabelled_thenTheAuthorsLabelWins", () => {
    const document = fanInDoc();
    document.edges[2].inputLabel = "the draft so far";
    const flow = documentToFlow(document);

    expect(withInputLabels(flow.nodes, flow.edges).find((e) => e.id === "e3")?.label).toBe(
      "the draft so far",
    );
  });

  it("given_anEdgeWithAnInputLabel_whenRoundTripped_thenTheLabelSurvives", () => {
    // Derived on the canvas, persisted in the document: a label the user wrote must
    // not be lost by opening the file and saving it again.
    const original = fanInDoc();
    original.edges[3].inputLabel = "the facts";
    const flow = documentToFlow(original);

    expect(flowToDocument(flow.nodes, flow.edges, original.workflow).edges).toEqual(
      original.edges,
    );
  });

  it("given_aConditionalsBranchTailsMeeting_whenLabelled_thenTheyAreNamedEvenThoughNoStepConcatenatesThem", () => {
    // A deliberate, pinned divergence from the compiler, not an oversight. The compiler
    // emits **no** fan-in prose here — only one branch runs, so only one result arrives —
    // while the canvas names both edges, because what it states is what an edge *carries*,
    // which is true of each of them whichever branch is taken. The canvas never claims the
    // results are concatenated; the step that would say so is the umbrella's.
    //
    // Answering the compiler's question instead would mean planning the document on every
    // canvas change — a drag is a new `nodes` array per frame, and a branching document's
    // plan allocates a transitive closure (8 MB at the node limit). That is the
    // frozen-window cost this codebase treats as a defect, paid on every frame, to remove
    // two labels that are not wrong. See ADR-0005.
    const document = fanInDoc();
    document.nodes.push(
      {
        id: "c1",
        type: "conditional",
        label: "Which?",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "b1", label: "yes" },
            { id: "b2", label: "no" },
          ],
        },
      },
      { id: "y", type: "prompt", label: "Yes path", data: { instruction: "y" } },
      { id: "n", type: "prompt", label: "No path", data: { instruction: "n" } },
      { id: "j", type: "prompt", label: "Join", data: { instruction: "j" } },
    );
    document.edges.push(
      { id: "e5", source: "c1", target: "y", branch: "b1" },
      { id: "e6", source: "c1", target: "n", branch: "b2" },
      { id: "e7", source: "y", target: "j" },
      { id: "e8", source: "n", target: "j" },
    );
    const flow = documentToFlow(document);

    const labelled = withInputLabels(flow.nodes, flow.edges);

    expect(labelled.find((e) => e.id === "e7")?.label).toBe("Yes path");
    expect(labelled.find((e) => e.id === "e8")?.label).toBe("No path");
  });

  it("given_aBranchEdge_whenLabelled_thenItKeepsTheBranchLabelItAlreadyHas", () => {
    // A branch is an alternative, not an input, and its label is the branch's — so the
    // two labellers cannot land on the same edge.
    const document = fanInDoc();
    document.nodes.push({
      id: "c1",
      type: "conditional",
      label: "Which?",
      data: {
        mode: "llm",
        question: "Which?",
        branches: [
          { id: "b1", label: "yes" },
          { id: "b2", label: "no" },
        ],
      },
    });
    document.edges.push({ id: "e5", source: "c1", target: "merge", branch: "b1" });
    document.edges.push({ id: "e6", source: "c1", target: "merge", branch: "b2" });
    const flow = documentToFlow(document);

    const labelled = withInputLabels(flow.nodes, flow.edges);

    expect(labelled.find((e) => e.id === "e5")?.label).toBe("yes");
    expect(labelled.find((e) => e.id === "e3")?.label).toBe("Draft");
  });
});
