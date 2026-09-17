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

function conditionalWith(branches: number, override: Partial<ConditionalData> = {}) {
  const data: ConditionalData = {
    mode: "llm",
    question: "Which way?",
    // Label = id, so what a row renders can be compared with what an edge's handle names.
    branches: Array.from({ length: branches }, (_, at) => ({ id: `b${at}`, label: `b${at}` })),
    ...override,
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

describe("ConditionalNode — which of the two things decides this branch", () => {
  it("given_anLlmConditional_whenRendered_thenItSaysTheModelDecidesAndShowsTheQuestion", () => {
    const { container } = conditionalWith(2);

    expect(screen.getByText("Conditional · LLM")).toBeTruthy();
    expect(container.querySelector(".pw-node__detail")?.textContent).toBe("Which way?");
  });

  it("given_aRuleBasedConditional_whenRendered_thenItSaysTheScaffoldDecidesAndShowsTheCheck", () => {
    // The mode is the difference between a branch the model judges and one the exported
    // scaffold decides, so it is on the node rather than only in the dock: it changes how
    // the whole workflow runs, and the canvas is where a workflow is read.
    conditionalWith(2, {
      mode: "rule",
      question: "",
      rule: {
        subject: "lines changed",
        operator: "greater-than",
        operand: "100",
        whenTrue: "b0",
        whenFalse: "b1",
      },
    });

    expect(screen.getByText("Conditional · Rule")).toBeTruthy();
    expect(screen.getByText("lines changed > 100")).toBeTruthy();
  });

  it("given_aRuleWhosePaddingIsPartOfTheComparison_whenRendered_thenThePaddingIsVisible", () => {
    // HTML collapses whitespace runs, so an unquoted ` 5` was the same pixels as `5` — the
    // author could not see, on the canvas, that this rule no longer matched what they
    // measured. Quoted, the difference is there to read.
    const { container } = conditionalWith(2, {
      mode: "rule",
      question: "",
      rule: {
        subject: "the count",
        operator: "equals",
        operand: " 5",
        whenTrue: "b0",
        whenFalse: "b1",
      },
    });

    expect(container.querySelector(".pw-node__detail")?.textContent).toBe(
      'the count = " 5"',
    );
  });

  it.each([
    ["no rule at all", undefined],
    [
      "a rule with nothing measured yet",
      {
        subject: "  ",
        operator: "equals" as const,
        operand: "",
        whenTrue: "b0",
        whenFalse: "b1",
      },
    ],
  ])(
    "given_aRuleBasedConditionalWith_%s_whenRendered_thenItReadsAsUnfinished",
    (_case, rule) => {
      conditionalWith(2, { mode: "rule", question: "", rule });

      expect(screen.getByText("no rule")).toBeTruthy();
    },
  );
});

describe("ConditionalNode — the loop guard is read off the canvas", () => {
  /** What this node says about passes, asked of the node rather than of the document. */
  function passesLine(container: HTMLElement): string | undefined {
    return [...container.querySelectorAll(".pw-node__detail")]
      .map((detail) => detail.textContent ?? "")
      .find((text) => text.startsWith("loops at most"));
  }

  it("given_aGuardedConditional_whenRendered_thenItSaysHowManyPassesItsLoopMayRun", () => {
    // How many times a workflow can go round is part of reading it, so it belongs on the
    // node beside the mode rather than only in the dock, one node at a time.
    const { container } = conditionalWith(2, { maxIterations: 3 });

    expect(passesLine(container)).toBe("loops at most 3 passes");
  });

  it("given_aGuardOfOne_whenRendered_thenItIsCountedInTheSingular", () => {
    const { container } = conditionalWith(2, { maxIterations: 1 });

    expect(passesLine(container)).toBe("loops at most 1 pass");
  });

  it("given_aConditionalWithNoGuard_whenRendered_thenNothingIsClaimedAboutPasses", () => {
    const { container } = conditionalWith(2);

    expect(passesLine(container)).toBeUndefined();
  });

  it("given_aGuardThatCouldNotStopALoop_whenRendered_thenItIsNotShownAsABound", () => {
    // `loopGuardOf` is the one read of the field, so the canvas cannot show a bound the
    // validator refuses as though the loop were bounded by it.
    const { container } = conditionalWith(2, { maxIterations: 0 });

    expect(passesLine(container)).toBeUndefined();
  });
});
