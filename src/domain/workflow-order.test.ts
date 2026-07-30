import { describe, expect, it } from "vitest";
import {
  branchesOf,
  CURRENT_SCHEMA_VERSION,
  validateGraph,
  type PatchworkDocument,
} from "./graph-document";
import {
  nestingDepth,
  plannedNodes,
  planWorkflow,
  type FlowSegment,
} from "./workflow-order";

/** Input -> Assess -> Conditional{a,b} -> (A | B) -> Summarize -> Output. */
function branchingDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Branching", description: "d" },
    nodes: [
      { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      { id: "assess", type: "prompt", label: "Assess", data: { instruction: "assess" } },
      {
        id: "c",
        type: "conditional",
        label: "Which way?",
        data: {
          mode: "llm",
          question: "Which way?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      },
      { id: "A", type: "prompt", label: "A", data: { instruction: "a" } },
      { id: "B", type: "prompt", label: "B", data: { instruction: "b" } },
      { id: "sum", type: "prompt", label: "Sum", data: { instruction: "sum" } },
      { id: "o", type: "output", label: "Out", data: { description: "r" } },
    ],
    edges: [
      { id: "e1", source: "i", target: "assess" },
      { id: "e2", source: "assess", target: "c" },
      { id: "e3", source: "c", target: "A", branch: "a" },
      { id: "e4", source: "c", target: "B", branch: "b" },
      { id: "e5", source: "A", target: "sum" },
      { id: "e6", source: "B", target: "sum" },
      { id: "e7", source: "sum", target: "o" },
    ],
  };
}

/** The shape of a segment list, as `<node id>` or `<node id>(<branch>: …)`. */
function outline(segments: readonly FlowSegment[]): string {
  return segments
    .map((segment) =>
      segment.kind === "step"
        ? segment.node.id
        : `${segment.node.id}(${segment.branches
            // `?.`, like every read of a branch entry: a hand-built document may hold anything
            // in that array, and this helper describes whatever the plan produced.
            .map((b) => `${b.branch?.id}: ${outline(b.segments)}`)
            .join(" | ")})`,
    )
    .join(" -> ");
}

describe("planWorkflow", () => {
  it("given_aLinearChain_whenPlanned_thenTheSegmentsFollowTheEdges", () => {
    const doc = branchingDocument();
    doc.nodes = doc.nodes.filter((n) => !["c", "A", "B"].includes(n.id));
    doc.edges = [
      { id: "e1", source: "i", target: "assess" },
      { id: "e2", source: "assess", target: "sum" },
      { id: "e7", source: "sum", target: "o" },
    ];

    expect(outline(planWorkflow(doc).segments)).toBe("i -> assess -> sum -> o");
  });

  it("given_aTwoWayBranch_whenPlanned_thenEachBranchHoldsItsOwnStepsAndTheJoinIsTopLevel", () => {
    // The convergence point belongs to neither branch: it runs whichever branch was
    // taken, so it is a step of the enclosing sequence.
    expect(outline(planWorkflow(branchingDocument()).segments)).toBe(
      "i -> assess -> c(a: A | b: B) -> sum -> o",
    );
  });

  it("given_aTwoWayBranch_whenPlanned_thenNothingIsReportedAsAProblem", () => {
    expect(planWorkflow(branchingDocument()).problems).toEqual([]);
  });

  it("given_aBranchWiredStraightToTheJoin_whenPlanned_thenItHasNoSegments", () => {
    const doc = branchingDocument();
    doc.nodes = doc.nodes.filter((n) => n.id !== "B");
    doc.edges = doc.edges.filter((e) => e.id !== "e6");
    doc.edges = doc.edges.map((e) => (e.id === "e4" ? { ...e, target: "sum" } : e));

    expect(outline(planWorkflow(doc).segments)).toBe("i -> assess -> c(a: A | b: ) -> sum -> o");
  });

  it("given_anUnwiredBranch_whenPlanned_thenTheChoiceIsStillPlannedAndNoStepIsLost", () => {
    // The plan stays total: validation refuses the export, and until then the canvas
    // and the compiler must both survive a half-wired conditional. With one branch
    // wired there is nothing to converge, so the one path taken is not *inside* the
    // choice — it simply follows it, which is what a conditional with one way out is.
    const doc = branchingDocument();
    doc.nodes = doc.nodes.filter((n) => n.id !== "B");
    doc.edges = doc.edges.filter((e) => e.id !== "e4" && e.id !== "e6");

    expect(outline(planWorkflow(doc).segments)).toBe("i -> assess -> c(a:  | b: ) -> A -> sum -> o");
  });

  it("given_aBranchOfDifferentLengths_whenPlanned_thenTheJoinIsTheFirstNodeBothReach", () => {
    // Branch `a` runs two steps, branch `b` one; `sum` is where they meet, and it must
    // not be swallowed into the longer branch.
    const doc = branchingDocument();
    doc.nodes.push({ id: "A2", type: "prompt", label: "A2", data: { instruction: "a2" } });
    doc.edges = doc.edges.map((e) => (e.id === "e5" ? { ...e, target: "A2" } : e));
    doc.edges.push({ id: "e8", source: "A2", target: "sum" });

    expect(outline(planWorkflow(doc).segments)).toBe(
      "i -> assess -> c(a: A -> A2 | b: B) -> sum -> o",
    );
  });

  it("given_anUnreachableNode_whenPlanned_thenItIsAppendedRatherThanDropped", () => {
    const doc = branchingDocument();
    doc.nodes.push({ id: "orphan", type: "prompt", label: "O", data: { instruction: "o" } });

    expect(plannedNodes(planWorkflow(doc)).map((n) => n.id)).toContain("orphan");
  });

  it("given_aCycle_whenPlanned_thenItTerminatesAndReportsTheRepeatedNode", () => {
    const doc = branchingDocument();
    doc.edges = doc.edges.map((e) => (e.id === "e6" ? { ...e, target: "assess" } : e));

    const plan = planWorkflow(doc);

    expect(plan.problems.some((p) => p.includes("reached more than once"))).toBe(true);
    expect(new Set(plannedNodes(plan).map((n) => n.id)).size).toBe(doc.nodes.length);
  });

  it("given_aDocumentWithNoInputNode_whenPlanned_thenEveryNodeIsStillPlanned", () => {
    const doc = branchingDocument();
    doc.nodes = doc.nodes.filter((n) => n.id !== "i");

    expect(plannedNodes(planWorkflow(doc))).toHaveLength(doc.nodes.length);
  });

  it("given_aChainDeeperThanTheCallStack_whenPlanned_thenItDoesNotThrow", () => {
    const doc = branchingDocument();
    doc.nodes = [doc.nodes[0], doc.nodes[doc.nodes.length - 1]];
    doc.edges = [];
    let previous = "i";
    for (let at = 0; at < 20_000; at += 1) {
      doc.nodes.push({
        id: `p${at}`,
        type: "prompt",
        label: "P",
        data: { instruction: "do" },
      });
      doc.edges.push({ id: `e${at}`, source: previous, target: `p${at}` });
      previous = `p${at}`;
    }
    doc.edges.push({ id: "e-last", source: previous, target: "o" });

    expect(() => planWorkflow(doc)).not.toThrow();
    expect(plannedNodes(planWorkflow(doc))).toHaveLength(doc.nodes.length);
  });

});

/**
 * `depth` conditionals nested one inside the other, and a merge chain that closes them
 * in the reverse order:
 *
 * ```
 * i -> C0 -- a --> C1 -- a --> … --> C(n-1) -- a --> m(n-1)
 *         \- b --> m0 <-- m1 <-- … <-- m(n-1),   m0 -> o
 * ```
 *
 * Each `C(i+1)` therefore lives *inside* branch `a` of `C(i)`, and `m(i)` is where
 * `C(i)`'s two branches converge: a genuinely nested workflow of the requested depth,
 * and a valid one.
 */
function deeplyNestedDocument(depth: number): PatchworkDocument {
  const doc: PatchworkDocument = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Nested", description: "d" },
    nodes: [
      { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
      { id: "o", type: "output", label: "Out", data: { description: "r" } },
    ],
    edges: [{ id: "e-in", source: "i", target: "c0" }],
  };
  for (let at = 0; at < depth; at += 1) {
    doc.nodes.push({
      id: `c${at}`,
      type: "conditional",
      label: "C",
      data: {
        mode: "llm",
        question: "Which?",
        branches: [
          { id: "a", label: "a" },
          { id: "b", label: "b" },
        ],
      },
    });
    doc.nodes.push({
      id: `m${at}`,
      type: "prompt",
      label: "M",
      data: { instruction: `merge ${at}` },
    });
    doc.edges.push({
      id: `a${at}`,
      source: `c${at}`,
      target: at + 1 === depth ? `m${at}` : `c${at + 1}`,
      branch: "a",
    });
    doc.edges.push({ id: `b${at}`, source: `c${at}`, target: `m${at}`, branch: "b" });
    doc.edges.push({
      id: `m${at}-e`,
      source: `m${at}`,
      target: at === 0 ? "o" : `m${at - 1}`,
    });
  }
  return doc;
}

describe("planWorkflow — nesting the call stack could not hold", () => {
  it("given_conditionalsNestedFiveThousandDeep_whenFlattened_thenItDoesNotThrow", () => {
    // `plannedNodes` was the one recursive traversal left in this module, so a
    // document `validateGraph` accepted could still fail an export with a
    // `RangeError` — through `compile` *and* through `vendorErrors`, the export's own
    // precondition check.
    const doc = deeplyNestedDocument(5_000);

    const nodes = plannedNodes(planWorkflow(doc));

    expect(nodes).toHaveLength(doc.nodes.length);
    expect(new Set(nodes.map((n) => n.id)).size).toBe(doc.nodes.length);
  });

  it("given_conditionalsNestedFiveThousandDeep_whenPlanned_thenTheNestingIsReallyThatDeep", () => {
    // Guards the *test*: a shape whose conditionals merely follow one another would
    // exercise none of this, which is how the recursion survived the first round.
    expect(nestingDepth(planWorkflow(deeplyNestedDocument(500)))).toBe(500);
  });

  it("given_aFlatSequenceOfConditionals_whenPlanned_thenTheNestingDepthIsOne", () => {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Flat", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [{ id: "e-in", source: "i", target: "c0" }],
    };
    for (let at = 0; at < 3; at += 1) {
      const next = at === 2 ? "o" : `c${at + 1}`;
      doc.nodes.push({
        id: `c${at}`,
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      });
      doc.nodes.push({
        id: `p${at}`,
        type: "prompt",
        label: "P",
        data: { instruction: "do" },
      });
      doc.edges.push({ id: `a${at}`, source: `c${at}`, target: `p${at}`, branch: "a" });
      doc.edges.push({ id: `p${at}-e`, source: `p${at}`, target: next });
      doc.edges.push({ id: `b${at}`, source: `c${at}`, target: next, branch: "b" });
    }

    expect(nestingDepth(planWorkflow(doc))).toBe(1);
  });
});

describe("planWorkflow — cost", () => {
  /**
   * Convergence used to re-sweep the whole reachable graph once per branch head per
   * conditional, so the plan was quadratic — and an export pays for it three times
   * (`validateGraph`, `vendorErrors`, `compile`). `compile` runs on the renderer's
   * main thread, so that is a frozen window, which this repo already treats as a
   * defect (see `collapseLineBreakRuns`). The budget is deliberately loose: it is
   * here to catch a return to quadratic, not to police milliseconds.
   */
  it("given_thousandsOfConditionals_whenPlanned_thenItCompletesPromptly", () => {
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Many", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [{ id: "e-in", source: "i", target: "c0" }],
    };
    const total = 6_000;
    for (let at = 0; at < total; at += 1) {
      const next = at + 1 === total ? "o" : `c${at + 1}`;
      doc.nodes.push({
        id: `c${at}`,
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      });
      doc.nodes.push({
        id: `p${at}`,
        type: "prompt",
        label: "P",
        data: { instruction: "do" },
      });
      doc.edges.push({ id: `a${at}`, source: `c${at}`, target: `p${at}`, branch: "a" });
      doc.edges.push({ id: `p${at}-e`, source: `p${at}`, target: next });
      doc.edges.push({ id: `b${at}`, source: `c${at}`, target: next, branch: "b" });
    }

    const started = performance.now();
    const plan = planWorkflow(doc);
    const elapsed = performance.now() - started;

    expect(plan.problems).toEqual([]);
    expect(plannedNodes(plan)).toHaveLength(doc.nodes.length);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("planWorkflow — a branch that converges on another branch point", () => {
  it("given_aConvergencePointThatIsItselfAConditional_whenPlanned_thenItOpensAtTopLevel", () => {
    // Converge, then diverge again: `c2` is where `c1`'s branches meet *and* the next
    // choice. ADR-0003 names nesting and re-convergence as the shapes that are supported;
    // this is the one where both meet in a single node, and nothing pinned it before.
    const doc: PatchworkDocument = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Re-diverge", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        {
          id: "c1",
          type: "conditional",
          label: "First",
          data: {
            mode: "llm",
            question: "First?",
            branches: [
              { id: "a", label: "a" },
              { id: "b", label: "b" },
            ],
          },
        },
        { id: "pa", type: "prompt", label: "PA", data: { instruction: "a" } },
        { id: "pb", type: "prompt", label: "PB", data: { instruction: "b" } },
        {
          id: "c2",
          type: "conditional",
          label: "Second",
          data: {
            mode: "llm",
            question: "Second?",
            branches: [
              { id: "c", label: "c" },
              { id: "d", label: "d" },
            ],
          },
        },
        { id: "pc", type: "prompt", label: "PC", data: { instruction: "c" } },
        { id: "pd", type: "prompt", label: "PD", data: { instruction: "d" } },
        { id: "m", type: "prompt", label: "M", data: { instruction: "m" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e1", source: "i", target: "c1" },
        { id: "e2", source: "c1", target: "pa", branch: "a" },
        { id: "e3", source: "c1", target: "pb", branch: "b" },
        { id: "e4", source: "pa", target: "c2" },
        { id: "e5", source: "pb", target: "c2" },
        { id: "e6", source: "c2", target: "pc", branch: "c" },
        { id: "e7", source: "c2", target: "pd", branch: "d" },
        { id: "e8", source: "pc", target: "m" },
        { id: "e9", source: "pd", target: "m" },
        { id: "e10", source: "m", target: "o" },
      ],
    };

    // `c2` belongs to neither of `c1`'s branches: it runs whichever one was taken.
    expect(outline(planWorkflow(doc).segments)).toBe(
      "i -> c1(a: pa | b: pb) -> c2(c: pc | d: pd) -> m -> o",
    );
    expect(planWorkflow(doc).problems).toEqual([]);
    expect(validateGraph(doc)).toEqual({ ok: true });
  });
});

/**
 * A cyclic document whose convergence point sits *before* the last of the branch heads in
 * topological order.
 *
 * `topologicalIndex` gives a node on a cycle no position and parks it after every sorted
 * one, so `x` and `m` here rank after `i` and `c1` in document order, and the node every
 * branch of `c1` reaches (`x`) ranks before the other head (`m`).
 */
function cyclicDocument(): PatchworkDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    workflow: { name: "Cyclic", description: "d" },
    nodes: [
      { id: "i", type: "input", label: "In", data: { parameters: [{ name: "q" }] } },
      {
        id: "c1",
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      },
      { id: "x", type: "prompt", label: "X", data: { instruction: "x" } },
      { id: "m", type: "prompt", label: "M", data: { instruction: "m" } },
      { id: "o", type: "output", label: "Out", data: { description: "r" } },
    ],
    edges: [
      { id: "e1", source: "i", target: "c1" },
      { id: "e2", source: "c1", target: "x", branch: "a" },
      { id: "e3", source: "c1", target: "m", branch: "b" },
      { id: "e4", source: "x", target: "m" },
      { id: "e5", source: "m", target: "x" },
      { id: "e6", source: "m", target: "o" },
    ],
  };
}

describe("planWorkflow — the rule holds on a document with a cycle too", () => {
  it("given_aCyclicDocument_whenPlanned_thenConvergenceIsTheEarliestCommonNodeNotNothing", () => {
    // The scan may only start at the last branch head in an *acyclic* graph. A parked
    // cycle node ranks after every sorted one, so here the shortcut skipped the whole
    // ordering and answered "the branches never converge" — which put `x` and `m` inside
    // a branch where the documented rule keeps them out of it. No user-visible effect
    // today, because `validateGraph` refuses a cycle; loops are a planned slice, and a
    // rule that is only true on currently-legal input is not the rule as written.
    expect(outline(planWorkflow(cyclicDocument()).segments)).toBe(
      // `x` is the convergence point, so it is a step of the enclosing sequence; `o` is
      // appended because the cycle keeps the walk from reaching it.
      "i -> c1(a:  | b: m) -> x -> o",
    );
  });

  it("given_aCyclicDocument_whenPlanned_thenTheRepeatedNodeIsStillReported", () => {
    expect(
      planWorkflow(cyclicDocument()).problems.some((p) => p.includes("reached more than once")),
    ).toBe(true);
  });
});

/**
 * A tiny reference implementation of the plan, written the way the rule reads rather than
 * the way it performs: reachability by sweeping, convergence by intersecting the heads'
 * reachable sets and taking the topologically earliest, and the walk by plain recursion.
 *
 * It exists so the optimised planner — transitive closure, topological scan, explicit
 * depth-first job stack — can be checked against the rule on thousands of documents
 * instead of against itself. ADR-0003 cites this check; keeping it in the repo is what
 * makes that citation something a reader can rerun.
 */
function referencePlan(doc: PatchworkDocument): { outline: string; problems: number } {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, Array<{ target: string; branch?: string }>>();
  for (const edge of doc.edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = outgoing.get(edge.source) ?? [];
    list.push({ target: edge.target, branch: edge.branch });
    outgoing.set(edge.source, list);
  }

  const reachable = (start: string): Set<string> => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      for (const edge of outgoing.get(queue.shift() as string) ?? []) {
        if (seen.has(edge.target)) continue;
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
    return seen;
  };

  // Kahn's algorithm, taking candidates in document order; nodes left over are on a cycle
  // and rank after every sorted one, by their position in the document.
  const order = new Map<string, number>();
  const remaining = new Map(doc.nodes.map((n) => [n.id, 0]));
  for (const edges of outgoing.values()) {
    for (const edge of edges) {
      remaining.set(edge.target, (remaining.get(edge.target) ?? 0) + 1);
    }
  }
  const ready = doc.nodes.filter((n) => remaining.get(n.id) === 0).map((n) => n.id);
  for (let at = 0; at < ready.length; at += 1) {
    order.set(ready[at], order.size);
    for (const edge of outgoing.get(ready[at]) ?? []) {
      const left = (remaining.get(edge.target) ?? 0) - 1;
      remaining.set(edge.target, left);
      if (left === 0) ready.push(edge.target);
    }
  }
  doc.nodes.forEach((node, at) => {
    if (!order.has(node.id)) order.set(node.id, doc.nodes.length + at);
  });

  const convergenceOf = (heads: string[]): string | undefined => {
    if (heads.length === 0) return undefined;
    let common: Set<string> | undefined;
    for (const head of heads) {
      const reach = reachable(head);
      common =
        common === undefined
          ? reach
          : new Set([...common].filter((id) => reach.has(id)));
    }
    let earliest: string | undefined;
    for (const id of common ?? []) {
      if (
        earliest === undefined ||
        (order.get(id) as number) < (order.get(earliest) as number)
      ) {
        earliest = id;
      }
    }
    return earliest;
  };

  const visited = new Set<string>();
  let problems = 0;
  const segments: FlowSegment[] = [];

  const walk = (
    collect: FlowSegment[],
    start: string | undefined,
    stop: ReadonlySet<string>,
  ): void => {
    let cursor = start;
    while (cursor !== undefined && !stop.has(cursor)) {
      const node = byId.get(cursor);
      if (node === undefined) return;
      if (visited.has(cursor)) {
        problems += 1;
        return;
      }
      visited.add(cursor);
      const edges = outgoing.get(cursor) ?? [];
      if (node.type !== "conditional") {
        collect.push({ kind: "step", node });
        cursor = edges[0]?.target;
        continue;
      }
      const heads = new Map<string, string>();
      for (const edge of edges) {
        if (edge.branch === undefined) continue;
        if (!heads.has(edge.branch)) heads.set(edge.branch, edge.target);
      }
      const join = convergenceOf([...new Set(heads.values())]);
      const planned = branchesOf(node).map((branch) => ({ branch, segments: [] as FlowSegment[] }));
      collect.push({ kind: "branch", node, branches: planned });
      const inner = join === undefined ? stop : new Set([...stop, join]);
      for (const entry of planned) {
        const head = heads.get(entry.branch.id);
        if (head === undefined) continue;
        walk(entry.segments, head, inner);
      }
      cursor = join;
      stop = stop; // the parent's own stops are unchanged
    }
  };

  const input = doc.nodes.find((n) => n.type === "input");
  if (input) walk(segments, input.id, new Set());
  for (const node of doc.nodes) {
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    segments.push(
      node.type === "conditional"
        ? { kind: "branch", node, branches: branchesOf(node).map((b) => ({ branch: b, segments: [] })) }
        : { kind: "step", node },
    );
  }
  return { outline: outline(segments), problems };
}

/** True when every edge points forward through the node list, i.e. the document is acyclic. */
function isForwardOnly(doc: PatchworkDocument): boolean {
  const position = new Map(doc.nodes.map((node, at) => [node.id, at]));
  return doc.edges.every(
    (edge) => (position.get(edge.source) ?? -1) < (position.get(edge.target) ?? -1),
  );
}

/**
 * A deterministic generator, so a failure names a document that can be rebuilt.
 *
 * Two knobs, and both of them decide which code path the corpus reaches:
 *
 * - `size` scales the node count, which matters beyond variety: the closure keeps one **bit**
 *   per node pair, so its word arithmetic (`bit >>> 5` to pick the word) is only exercised
 *   above 32 nodes — below that every row is one word and a wrong word index is invisible.
 * - `backwards` is the chance that an edge points at an *earlier* node. At zero the document
 *   is acyclic by construction, which is the only way the corpus reaches the transitive
 *   closure at all: a single cycle sends the whole plan down the sweep fallback instead. A
 *   corpus of "mostly cyclic" documents silently tests one implementation twice.
 */
function randomDocuments(
  count: number,
  seed: number,
  backwards: number,
  size = 1,
): PatchworkDocument[] {
  // xorshift32: small, seeded, and good enough to shuffle a graph shape.
  let state = seed | 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  const pick = (limit: number) => Math.floor(next() * limit);

  const documents: PatchworkDocument[] = [];
  for (let at = 0; at < count; at += 1) {
    const prompts = size * (1 + pick(5));
    const conditionals = size * (1 + pick(3));
    const nodes: PatchworkDocument["nodes"] = [
      { id: "i", type: "input", label: "In", data: { parameters: [{ name: "q" }] } },
    ];
    for (let n = 0; n < prompts; n += 1) {
      nodes.push({ id: `p${n}`, type: "prompt", label: "P", data: { instruction: `do ${n}` } });
    }
    for (let n = 0; n < conditionals; n += 1) {
      nodes.push({
        id: `c${n}`,
        type: "conditional",
        label: "C",
        data: {
          mode: "llm",
          question: "Which?",
          branches: [
            { id: "a", label: "a" },
            { id: "b", label: "b" },
          ],
        },
      });
    }
    // The Output node last, so "later in this list" is a topological order: an edge that only
    // ever points forward cannot close a cycle.
    nodes.push({ id: "o", type: "output", label: "Out", data: { description: "r" } });

    const edges: PatchworkDocument["edges"] = [];
    let edgeId = 0;
    nodes.forEach((source, position) => {
      if (source.type === "output") return;
      const ways = source.type === "conditional" ? ["a", "b"] : [undefined];
      for (const branch of ways) {
        const back = next() < backwards;
        const candidates = nodes
          .map((node, index) => ({ id: node.id, index }))
          .filter(({ id, index }) =>
            back ? id !== source.id && id !== "i" : index > position,
          )
          .map(({ id }) => id);
        if (candidates.length === 0) continue;
        edges.push({
          id: `e${(edgeId += 1)}`,
          source: source.id,
          target: candidates[pick(candidates.length)],
          ...(branch === undefined ? {} : { branch }),
        });
      }
    });
    documents.push({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Generated", description: "d" },
      nodes,
      edges,
    });
  }
  return documents;
}

describe("planWorkflow — differential against the rule as written", () => {
  it.each([
    ["acyclic shapes", 300, 0x5eed, 0, 1],
    ["shapes full of backward edges", 300, 0x1dea, 0.25, 1],
    // Above one machine word, which is where the closure's word arithmetic starts to matter.
    ["acyclic shapes wider than one machine word", 150, 0xc0de, 0, 6],
    ["wide shapes full of backward edges", 150, 0xfade, 0.25, 6],
  ])(
    "given_%s_whenPlanned_thenTheOptimisedPlanMatchesTheNaiveReference",
    (_case, count, seed, backwards, size) => {
      const mismatches: string[] = [];
      let widest = 0;
      let acyclic = 0;
      for (const doc of randomDocuments(count, seed, backwards, size)) {
        widest = Math.max(widest, doc.nodes.length);
        if (isForwardOnly(doc)) acyclic += 1;
        const mine = planWorkflow(doc);
        const reference = referencePlan(doc);
        if (
          outline(mine.segments) !== reference.outline ||
          (mine.problems.length === 0) !== (reference.problems === 0)
        ) {
          mismatches.push(
            `${JSON.stringify(doc.edges)}\n  mine: ${outline(mine.segments)}\n  ref:  ${reference.outline}`,
          );
        }
      }

      expect(mismatches).toEqual([]);
      // Both properties the corpus is chosen for, asserted so neither can quietly lapse: the
      // documents are wide enough to need more than one word of the closure, and the acyclic
      // corpora really are acyclic — which is what sends them through the closure rather than
      // through the sweep fallback.
      expect(widest).toBeGreaterThan(size > 1 ? 32 : 3);
      expect(acyclic).toBe(backwards === 0 ? count : acyclic);
      if (backwards === 0) expect(acyclic).toBe(count);
    },
  );

  it.each([
    ["acyclic shapes", 200, 0xf00d, 0, 1],
    ["shapes full of backward edges", 200, 0xbeef, 0.25, 1],
    ["acyclic shapes wider than one machine word", 100, 0xd15c, 0, 6],
  ])(
    "given_%s_whenTheClosureIsRefused_thenTheSweepFallbackAgreesWithIt",
    (_case, count, seed, backwards, size) => {
      // The size fallback is otherwise only reachable at some 16,000 nodes — far past what
      // a test should build — so the ceiling is lowered instead. Both spellings of
      // reachability have to answer the same question.
      const mismatches: string[] = [];
      for (const doc of randomDocuments(count, seed, backwards, size)) {
        const closure = outline(planWorkflow(doc).segments);
        const swept = outline(planWorkflow(doc, { maxClosureBytes: 0 }).segments);
        if (closure !== swept) mismatches.push(`${closure} != ${swept}`);
      }

      expect(mismatches).toEqual([]);
    },
  );
});

describe("planWorkflow — the cost of nesting", () => {
  it("given_thousandsOfNestedConditionals_whenPlanned_thenItCompletesPromptly", () => {
    // The stops a branch body must respect are the joins of the conditionals enclosing it.
    // Copying that set at every level cost O(depth) per level, so planning was quadratic in
    // the depth: 8,000 levels took 2.8 s and 12,000 took 40 s — on the renderer's main
    // thread, and paid three times per export. The budget is loose on purpose: it is here
    // to catch a return to quadratic, not to police milliseconds.
    const doc = deeplyNestedDocument(8_000);

    const started = performance.now();
    const plan = planWorkflow(doc);
    const elapsed = performance.now() - started;

    expect(nestingDepth(plan)).toBe(8_000);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("planWorkflow — a branch entry that is not a branch", () => {
  /**
   * `branches: [null, {...}]`. Unreachable in the product — `deserialize` rejects it and the
   * canvas can only mint `{id, label}` — but this module's header says nothing here throws for
   * any document however malformed, and `branchesOf` advertises tolerance for hand-edited ones.
   * That tolerance covered the array and not its entries: one unguarded `entry.branch.id` where
   * every neighbour already wrote `branch?.`, and six functions threw a `TypeError` through it.
   */
  function documentWithANullBranch(): PatchworkDocument {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      workflow: { name: "Hostile", description: "d" },
      nodes: [
        { id: "i", type: "input", label: "In", data: { parameters: [{ name: "x" }] } },
        {
          id: "c",
          type: "conditional",
          label: "C",
          data: {
            mode: "llm",
            question: "Which?",
            branches: [null, { id: "b", label: "b" }] as unknown as Array<{
              id: string;
              label: string;
            }>,
          },
        },
        { id: "p", type: "prompt", label: "P", data: { instruction: "do" } },
        { id: "o", type: "output", label: "Out", data: { description: "r" } },
      ],
      edges: [
        { id: "e1", source: "i", target: "c" },
        { id: "e2", source: "c", target: "p", branch: "b" },
        { id: "e3", source: "p", target: "o" },
      ],
    };
  }

  it("given_aNullBranchEntry_whenPlanned_thenNothingThrowsAndTheWiredBranchIsStillWalked", () => {
    const doc = documentWithANullBranch();

    const plan = planWorkflow(doc);

    // One branch wired means nothing to converge, so the path it names simply follows the
    // choice — the same degenerate reading `given_anUnwiredBranch_...` pins. The point here is
    // that the null entry is planned as a branch with no steps instead of throwing.
    expect(outline(plan.segments)).toBe("i -> c(undefined:  | b: ) -> p -> o");
    expect(plannedNodes(plan)).toHaveLength(4);
    expect(nestingDepth(plan)).toBe(1);
  });

  it("given_aNullBranchEntry_whenValidated_thenItIsRejectedRatherThanThrown", () => {
    const result = validateGraph(documentWithANullBranch());

    expect(result.ok).toBe(false);
  });
});
