// @vitest-environment jsdom
/**
 * What a node draws when the document asks for more than it can draw.
 *
 * A conditional renders one source handle per branch, and a document may legitimately be
 * *opened* with more branches than the export bound allows — refusing to open it was the wrong
 * failure mode (see ADR-0003). So the node bounds what it draws, says how many it left out, and
 * carries the same flag an unresolved artifact reference does.
 */
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  branchesWithinLimit,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ConditionalData,
} from "../domain/graph-document";
import { ConditionalNode } from "./nodes";
import type { PatchNode } from "./react-flow-adapter";

function conditionalWith(branches: number) {
  const data: ConditionalData = {
    mode: "llm",
    question: "Which way?",
    // Label = id, so what a row renders can be compared with what an edge's handle names.
    branches: Array.from({ length: branches }, (_, at) => ({ id: `b${at}`, label: `b${at}` })),
  };
  // React Flow hands its node components a wide props object; only these two are read here.
  const props = {
    data: { label: "Which way?", node: data },
    selected: false,
  } as unknown as NodeProps<PatchNode>;
  return render(
    <ReactFlowProvider>
      <ConditionalNode {...props} />
    </ReactFlowProvider>,
  );
}

describe("ConditionalNode", () => {
  it("given_aConditionalWithinTheLimit_whenRendered_thenEveryBranchIsDrawn", () => {
    const { container } = conditionalWith(3);

    expect(container.querySelectorAll(".pw-node__branch")).toHaveLength(3);
    expect(container.querySelector(".is-over-width")).toBeNull();
    expect(screen.getByText("b2")).toBeTruthy();
  });

  it("given_aConditionalPastTheLimit_whenRendered_thenOnlyTheLimitsWorthOfHandlesIsDrawn", () => {
    const { container } = conditionalWith(5_000);

    expect(container.querySelectorAll(".pw-node__branch")).toHaveLength(
      MAX_BRANCHES_PER_CONDITIONAL,
    );
  });

  it("given_aConditionalPastTheLimit_whenRendered_thenTheHandlesDrawnAreTheOnesEveryOtherSurfaceShows", () => {
    // Three surfaces used to slice the same list independently — this node, the dock's rows, and
    // `drawableEdges` — and only one of the three was pinned, so a future drift could give
    // handles whose edges were filtered away with nothing failing. They now share one
    // definition, and each surface asserts against it. (The dock's half is in
    // `NodeEditor.test.tsx`, the edges' in `react-flow-adapter.test.ts`.)
    const branches = Array.from({ length: 90 }, (_, at) => ({ id: `b${at}`, label: `b${at}` }));
    const { container } = conditionalWith(90);

    const drawn = [...container.querySelectorAll(".pw-node__branch")].map(
      (row) => row.textContent,
    );
    expect(drawn).toEqual(branchesWithinLimit(branches).map((branch) => branch.label));
  });

  it("given_aConditionalPastTheLimit_whenRendered_thenItSaysHowManyItLeftOut", () => {
    conditionalWith(5_000);

    expect(
      screen.getByText(
        `5000 branches, over the limit of ${MAX_BRANCHES_PER_CONDITIONAL} — the rest are in the document but not drawn`,
      ),
    ).toBeTruthy();
  });

  it("given_aConditionalPastTheLimit_whenRendered_thenItIsFlaggedLikeAnUnresolvedReference", () => {
    // Same visual language: the node is present, editable, and visibly wrong.
    const { container } = conditionalWith(5_000);

    expect(container.querySelector(".pw-node--conditional.is-over-width")).toBeTruthy();
  });

  it("given_aConditionalWithFiveThousandBranches_whenRendered_thenItRendersPromptly", () => {
    // The load path's guarantee, measured. The structural bound above is the real guard —
    // this budget is here to catch a change that starts drawing all of them again, which is
    // what froze a real browser for 10.8 s at 20,000 branches.
    const started = performance.now();

    conditionalWith(5_000);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
