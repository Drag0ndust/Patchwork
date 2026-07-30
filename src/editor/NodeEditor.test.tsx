// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PatchNode } from "../canvas/react-flow-adapter";
import {
  branchesWithinLimit,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ExportMode,
  type NodeData,
} from "../domain/graph-document";
import { buildCatalog, type ImportCatalog } from "../import/catalog";
import type { SourceRoot } from "../import/source-roots";
import { NodeEditor } from "./NodeEditor";

const PERSONAL: SourceRoot = {
  id: "personal:~/.claude",
  path: "~/.claude",
  role: "personal",
};

function catalog(): ImportCatalog {
  return buildCatalog([PERSONAL], {
    artifacts: [
      {
        rootId: PERSONAL.id,
        kind: "skill",
        name: "tdd",
        path: "~/.claude/skills/tdd/SKILL.md",
        contents: "---\ndescription: Red-green-refactor.\n---\n\nBody.\n",
      },
      {
        rootId: PERSONAL.id,
        kind: "agent",
        name: "reviewer",
        path: "~/.claude/agents/reviewer.md",
        contents: "---\nname: reviewer\ndescription: Reviews PRs.\n---\n\nBody.\n",
      },
    ],
    problems: [],
  });
}

/**
 * Resolve what the editor emitted against the node's data as it is *now*.
 *
 * Every data edit is sent as an update over the current data rather than as a
 * rebuilt object, so the tests apply it the same way `App.updateNode` does.
 */
function applied(edit: unknown, current: NodeData): NodeData {
  return typeof edit === "function"
    ? (edit as (prev: NodeData) => NodeData)(current)
    : (edit as NodeData);
}

function skillNode(name = "", exportMode: ExportMode = "reference"): PatchNode {
  return {
    id: "n2",
    type: "skill",
    position: { x: 0, y: 0 },
    data: {
      label: "Skill",
      node: { name, rootId: name === "" ? "" : PERSONAL.id, exportMode },
    },
  };
}

describe("NodeEditor — imported artifact picker", () => {
  it("given_unboundSkillNode_whenRendered_thenOnlySkillsFromTheCatalogAreOffered", () => {
    render(<NodeEditor node={skillNode()} catalog={catalog()} onChange={vi.fn()} />);

    const picker = screen.getByLabelText("Imported skill") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["", "tdd"]);
  });

  it("given_pickedArtifact_whenSelected_thenNodeStoresNameAndSymbolicRootId", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "tdd" },
    });

    expect(onChange.mock.calls[0].slice(0, 2)).toEqual(["n2", "Skill"]);
    expect(
      applied(onChange.mock.calls[0][2], { name: "", rootId: "", exportMode: "reference" }),
    ).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "reference",
    });
  });

  it("given_boundArtifact_whenRendered_thenItShowsWhereTheReferenceResolvesTo", () => {
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={vi.fn()} />);

    expect(screen.getByText("~/.claude/skills/tdd/SKILL.md")).toBeTruthy();
    expect(screen.getByText(/Red-green-refactor\./)).toBeTruthy();
  });

  it("given_referenceToAnAbsentArtifact_whenRendered_thenItStaysSelectedAndIsFlagged", () => {
    render(
      <NodeEditor node={skillNode("moved-away")} catalog={catalog()} onChange={vi.fn()} />,
    );

    const picker = screen.getByLabelText("Imported skill") as HTMLSelectElement;
    expect(picker.value).toBe("moved-away");
    expect(screen.getByText(/is not in any configured source root/)).toBeTruthy();
  });
});

describe("NodeEditor — the per-node export choice", () => {
  it("given_refNode_whenRendered_thenBothExportModesAreOffered", () => {
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={vi.fn()} />);

    const picker = screen.getByLabelText("On export") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual([
      "reference",
      "vendor",
    ]);
    expect(picker.value).toBe("reference");
  });

  it("given_referenceModeNode_whenVendorIsPicked_thenTheChoiceIsStoredOnTheNode", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("On export"), {
      target: { value: "vendor" },
    });

    const [id, label, update] = onChange.mock.calls[0] as [
      string,
      string,
      (prev: NodeData) => NodeData,
    ];
    expect([id, label]).toEqual(["n2", "Skill"]);
    expect(update({ name: "tdd", rootId: "personal:~/.claude" })).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "vendor",
    });
  });

  it("given_aModeChange_whenEmitted_thenItIsAppliedToTheLatestDataRatherThanTheRenderedProps", () => {
    // The mode is one field of the node's data, and so is the binding. Emitting a
    // whole object built from the rendered props would let a mode change that
    // lands in the same tick as an artifact pick overwrite the binding with the
    // stale one — so the change is sent as an update over whatever is current.
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode("")} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("On export"), {
      target: { value: "vendor" },
    });

    const update = onChange.mock.calls[0][2] as (prev: NodeData) => NodeData;
    expect(update({ name: "tdd", rootId: "personal:~/.claude" })).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "vendor",
    });
  });

  it("given_aModeChangeAndThenAPickWithNoRenderBetween_whenBothAreApplied_thenNeitherOverwritesTheOther", () => {
    // Both controls edit different fields of the same data. Neither may rebuild the
    // object from the props it rendered with, or whichever fires second silently
    // reverts the other — the loss ADR-0002 §2b says must not happen, here between
    // a vendor choice and the binding it applies to. The mock never re-renders the
    // editor, which is exactly the same-tick situation.
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("On export"), {
      target: { value: "vendor" },
    });
    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "tdd" },
    });

    const start: NodeData = { name: "", rootId: "", exportMode: "reference" };
    const afterBoth = applied(
      onChange.mock.calls[1][2],
      applied(onChange.mock.calls[0][2], start),
    );
    expect(afterBoth).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "vendor",
    });
  });

  it("given_vendorModeNode_whenRendered_thenThatIsTheSelectedChoice", () => {
    render(
      <NodeEditor node={skillNode("tdd", "vendor")} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect((screen.getByLabelText("On export") as HTMLSelectElement).value).toBe(
      "vendor",
    );
  });

  it("given_vendorModeNode_whenAnotherArtifactIsPicked_thenTheChoiceIsNotReset", () => {
    // Rebinding a node is about *which* artifact, not about how it is exported;
    // silently reverting to reference-by-name would drop the copy from the bundle.
    const onChange = vi.fn();
    render(
      <NodeEditor node={skillNode("moved-away", "vendor")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "tdd" },
    });

    expect(
      applied(onChange.mock.calls[0][2], {
        name: "moved-away",
        rootId: "personal:~/.claude",
        exportMode: "vendor",
      }),
    ).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "vendor",
    });
  });

  it("given_vendorModeNode_whenUnbound_thenTheChoiceStillSurvives", () => {
    const onChange = vi.fn();
    render(
      <NodeEditor node={skillNode("tdd", "vendor")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "" },
    });

    expect(
      applied(onChange.mock.calls[0][2], {
        name: "tdd",
        rootId: "personal:~/.claude",
        exportMode: "vendor",
      }),
    ).toEqual({ name: "", rootId: "", exportMode: "vendor" });
  });
});

describe("NodeEditor — unbinding", () => {
  it("given_boundNode_whenThePlaceholderIsSelected_thenTheReferenceIsCleared", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "" },
    });

    expect(
      applied(onChange.mock.calls[0][2], {
        name: "tdd",
        rootId: "personal:~/.claude",
        exportMode: "reference",
      }),
    ).toEqual({ name: "", rootId: "", exportMode: "reference" });
  });

  it("given_unresolvedNode_whenRepickedFromTheCatalog_thenItRebinds", () => {
    const onChange = vi.fn();
    render(
      <NodeEditor node={skillNode("moved-away")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "tdd" },
    });

    expect(
      applied(onChange.mock.calls[0][2], {
        name: "moved-away",
        rootId: "personal:~/.claude",
        exportMode: "reference",
      }),
    ).toEqual({
      name: "tdd",
      rootId: "personal:~/.claude",
      exportMode: "reference",
    });
  });
});

function conditionalNode(branches?: Array<{ id: string; label: string }>): PatchNode {
  return {
    id: "c1",
    type: "conditional",
    position: { x: 0, y: 0 },
    data: {
      label: "Has a stack trace?",
      node: {
        mode: "llm",
        question: "Does the report contain a stack trace?",
        branches: branches ?? [
          { id: "b1", label: "with trace" },
          { id: "b2", label: "no trace" },
        ],
      },
    },
  };
}

describe("NodeEditor — a Conditional node's branches", () => {
  it("given_aConditionalNode_whenRendered_thenItIsNamedAsOne", () => {
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect(screen.getByText("Conditional node")).toBeTruthy();
  });

  it("given_aConditionalNode_whenRendered_thenEveryBranchLabelIsEditable", () => {
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText("Branch 1 label") as HTMLInputElement).value).toBe(
      "with trace",
    );
    expect((screen.getByLabelText("Branch 2 label") as HTMLInputElement).value).toBe(
      "no trace",
    );
  });

  it("given_aConditionalNode_whenTheQuestionIsEdited_thenTheBranchesAreLeftAlone", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Decision question"), {
      target: { value: "Is it a crash?" },
    });

    expect(applied(onChange.mock.calls[0][2], conditionalNode().data.node)).toEqual({
      mode: "llm",
      question: "Is it a crash?",
      branches: [
        { id: "b1", label: "with trace" },
        { id: "b2", label: "no trace" },
      ],
    });
  });

  it("given_aBranch_whenRelabelled_thenItsIdIsUnchanged", () => {
    // The id is what edges are attached by, so renaming a branch must not re-key it:
    // that is the whole reason the label and the id are separate fields (ADR-0003).
    const onChange = vi.fn();
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Branch 2 label"), {
      target: { value: "needs a trace" },
    });

    expect(applied(onChange.mock.calls[0][2], conditionalNode().data.node)).toEqual({
      mode: "llm",
      question: "Does the report contain a stack trace?",
      branches: [
        { id: "b1", label: "with trace" },
        { id: "b2", label: "needs a trace" },
      ],
    });
  });

  it("given_aConditionalNode_whenABranchIsAdded_thenItGetsAFreshIdAndAnEmptyLabel", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add branch" }));

    const data = applied(
      onChange.mock.calls[0][2],
      conditionalNode().data.node,
    ) as { branches: Array<{ id: string; label: string }> };
    expect(data.branches).toHaveLength(3);
    expect(data.branches[2].label).toBe("");
    expect(new Set(data.branches.map((b) => b.id)).size).toBe(3);
  });

  it("given_threeBranches_whenOneIsRemoved_thenOnlyThatOneGoes", () => {
    const onChange = vi.fn();
    const node = conditionalNode([
      { id: "b1", label: "with trace" },
      { id: "b2", label: "no trace" },
      { id: "b3", label: "not a bug" },
    ]);
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove branch no trace" }));

    expect(applied(onChange.mock.calls[0][2], node.data.node)).toEqual({
      mode: "llm",
      question: "Does the report contain a stack trace?",
      branches: [
        { id: "b1", label: "with trace" },
        { id: "b3", label: "not a bug" },
      ],
    });
  });

  it("given_twoBranches_whenRendered_thenNeitherCanBeRemoved", () => {
    // A choice between one thing is not a choice, and `validateGraph` refuses it — so
    // the editor does not offer the edit that would produce it.
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      (screen.getByRole("button", { name: "Remove branch no trace" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("NodeEditor — the branch limit", () => {
  it("given_aConditionalAtTheBranchLimit_whenRendered_thenNoFurtherBranchIsOffered", () => {
    // The same courtesy the two-branch floor gets: the editor does not offer the edit that
    // would produce a document `validateGraph` refuses — and past the limit the canvas would
    // be drawing more source handles than it can draw responsively, so the button is the
    // cheapest place to stop.
    const node = conditionalNode(
      Array.from({ length: MAX_BRANCHES_PER_CONDITIONAL }, (_, at) => ({
        id: `b${at}`,
        label: `branch ${at}`,
      })),
    );
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      (screen.getByRole("button", { name: "Add branch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("given_aConditionalOneBranchBelowTheLimit_whenRendered_thenAnotherBranchIsStillOffered", () => {
    const node = conditionalNode(
      Array.from({ length: MAX_BRANCHES_PER_CONDITIONAL - 1 }, (_, at) => ({
        id: `b${at}`,
        label: `branch ${at}`,
      })),
    );
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      (screen.getByRole("button", { name: "Add branch" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("NodeEditor — the branch limits are stated, not just enforced", () => {
  function branchesFor(count: number) {
    return Array.from({ length: count }, (_, at) => ({ id: `b${at}`, label: `branch ${at}` }));
  }

  it("given_aConditional_whenRendered_thenTheBranchCountAndItsCeilingAreVisible", () => {
    render(
      <NodeEditor node={conditionalNode(branchesFor(3))} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(screen.getByText(`Branches (3 of ${MAX_BRANCHES_PER_CONDITIONAL})`)).toBeTruthy();
  });

  it("given_aConditionalAtTheBranchLimit_whenRendered_thenTheReasonIsStatedAndNotOnlyDisabled", () => {
    // A control that stops working without saying why is the defect: the number and the way
    // out both have to be on screen. `role="status"` so a screen reader hears it when the
    // limit is reached rather than discovering a dead button.
    render(
      <NodeEditor
        node={conditionalNode(branchesFor(MAX_BRANCHES_PER_CONDITIONAL))}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    const add = screen.getByRole("button", { name: "Add branch" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(add.title).toContain(`${MAX_BRANCHES_PER_CONDITIONAL}`);
    expect(screen.getByRole("status").textContent).toBe(
      `At the limit of ${MAX_BRANCHES_PER_CONDITIONAL} branches. Remove one, or branch again inside a branch.`,
    );
  });

  it("given_aConditionalAtTheTwoBranchFloor_whenRendered_thenThatReasonIsStatedToo", () => {
    // The floor was enforced the same silent way. Same treatment.
    render(
      <NodeEditor node={conditionalNode(branchesFor(2))} catalog={catalog()} onChange={vi.fn()} />,
    );

    const remove = screen.getByRole("button", {
      name: "Remove branch branch 1",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    expect(remove.title).toContain("two");
    expect(screen.getByRole("status").textContent).toBe(
      "A conditional offers a choice, so it keeps at least two branches.",
    );
  });

  it("given_aConditionalBetweenTheLimits_whenRendered_thenNothingIsAnnounced", () => {
    render(
      <NodeEditor node={conditionalNode(branchesFor(4))} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("NodeEditor — a conditional that was opened over the limit", () => {
  function branchesFor(count: number) {
    return Array.from({ length: count }, (_, at) => ({ id: `b${at}`, label: `branch ${at}` }));
  }

  const OVER = MAX_BRANCHES_PER_CONDITIONAL + 36;

  it("given_aConditionalOverTheLimit_whenRendered_thenOnlyTheLimitsWorthOfRowsIsShown", () => {
    // The dock is one click from the canvas, so it needs the same bound the canvas has: a
    // document may be *opened* over the limit, and rendering thousands of inputs would freeze
    // selecting the node.
    render(
      <NodeEditor node={conditionalNode(branchesFor(OVER))} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(screen.getAllByLabelText(/^Branch \d+ label$/)).toHaveLength(
      MAX_BRANCHES_PER_CONDITIONAL,
    );
  });

  it("given_aConditionalOverTheLimit_whenRendered_thenTheRowsShownAreTheOnesEveryOtherSurfaceShows", () => {
    // The dock's half of the three-way agreement: the same definition the canvas node and the
    // edge filter use. See the companion assertions in `canvas/nodes.test.tsx` and
    // `canvas/react-flow-adapter.test.ts`.
    const branches = branchesFor(OVER);
    render(
      <NodeEditor node={conditionalNode(branches)} catalog={catalog()} onChange={vi.fn()} />,
    );

    const rows = screen
      .getAllByLabelText(/^Branch \d+ label$/)
      .map((input) => (input as HTMLInputElement).value);
    expect(rows).toEqual(branchesWithinLimit(branches).map((branch) => branch.label));
  });

  it("given_aConditionalOverTheLimit_whenRendered_thenItSaysWhatIsWrongAndWhatIsHidden", () => {
    render(
      <NodeEditor node={conditionalNode(branchesFor(OVER))} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(screen.getByRole("status").textContent).toBe(
      `${OVER} branches, over the limit of ${MAX_BRANCHES_PER_CONDITIONAL}. The first ${MAX_BRANCHES_PER_CONDITIONAL} are shown; the export is refused until the rest are removed.`,
    );
  });

  it("given_aConditionalOverTheLimit_whenTheOfferedRepairIsTaken_thenExactlyTheExcessIsRemoved", () => {
    // Recovery has to be possible *in the app*: deleting rows one at a time would take 36
    // clicks here and thousands on a generated document. The button says exactly how many
    // branches it removes, and removes nothing else — the user chooses the loss.
    const onChange = vi.fn();
    const node = conditionalNode(branchesFor(OVER));
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: `Remove the ${OVER - MAX_BRANCHES_PER_CONDITIONAL} branches past the limit`,
      }),
    );

    const data = applied(onChange.mock.calls[0][2], node.data.node) as {
      branches: Array<{ id: string }>;
    };
    expect(data.branches).toHaveLength(MAX_BRANCHES_PER_CONDITIONAL);
    expect(data.branches[0].id).toBe("b0");
    expect(data.branches[MAX_BRANCHES_PER_CONDITIONAL - 1].id).toBe(
      `b${MAX_BRANCHES_PER_CONDITIONAL - 1}`,
    );
  });

  it("given_aConditionalWithinTheLimit_whenRendered_thenNoRepairIsOffered", () => {
    render(
      <NodeEditor node={conditionalNode(branchesFor(4))} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(screen.queryByRole("button", { name: /branches past the limit/ })).toBeNull();
  });
});
