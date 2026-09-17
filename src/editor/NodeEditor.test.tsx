// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PatchNode } from "../canvas/react-flow-adapter";
import {
  branchesWithinLimit,
  DEFAULT_RULE_OPERATOR,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ConditionalData,
  type ConditionalRule,
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

/** The same conditional, decided by a rule the exported scaffold evaluates. */
function ruleConditionalNode(rule?: Partial<ConditionalRule>): PatchNode {
  const node = conditionalNode();
  node.data.node = {
    mode: "rule",
    question: "",
    rule: {
      subject: "the number of stack frames in the report",
      operator: "greater-than",
      operand: "0",
      whenTrue: "b1",
      whenFalse: "b2",
      ...rule,
    },
    branches: [
      { id: "b1", label: "with trace" },
      { id: "b2", label: "no trace" },
    ],
  };
  return node;
}

describe("NodeEditor — choosing what decides a Conditional", () => {
  it("given_anLlmConditional_whenRendered_thenTheQuestionIsEditedAndNoRuleIs", () => {
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText("Decided by") as HTMLSelectElement).value).toBe("llm");
    expect(screen.getByLabelText("Decision question")).toBeTruthy();
    expect(screen.queryByLabelText("Value to measure")).toBeNull();
  });

  it("given_anLlmConditional_whenSwitchedToRuleBased_thenItGetsARuleToFillInAndKeepsTheQuestion", () => {
    // The question is kept rather than cleared: switching modes to look at the other one
    // must not cost the user what they wrote (the compiler reads only the mode's own field).
    const onChange = vi.fn();
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Decided by"), { target: { value: "rule" } });

    expect(applied(onChange.mock.calls[0][2], conditionalNode().data.node)).toEqual({
      mode: "rule",
      question: "Does the report contain a stack trace?",
      rule: {
        subject: "",
        operator: DEFAULT_RULE_OPERATOR,
        operand: "",
        // Routed to the branches the node already offers, so a fresh rule is wired
        // rather than pointing at nothing.
        whenTrue: "b1",
        whenFalse: "b2",
      },
      branches: [
        { id: "b1", label: "with trace" },
        { id: "b2", label: "no trace" },
      ],
    });
  });

  it("given_aRuleBasedConditional_whenSwitchedBackAndForth_thenTheRuleIsKept", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Decided by"), { target: { value: "llm" } });

    expect(applied(onChange.mock.calls[0][2], ruleConditionalNode().data.node)).toEqual({
      ...ruleConditionalNode().data.node,
      mode: "llm",
    });
  });

  it("given_aRuleBasedConditional_whenRendered_thenEveryPartOfTheCheckIsEditable", () => {
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText("Value to measure") as HTMLTextAreaElement).value).toBe(
      "the number of stack frames in the report",
    );
    expect((screen.getByLabelText("Comparison") as HTMLSelectElement).value).toBe(
      "greater-than",
    );
    expect((screen.getByLabelText("Compared against") as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("When it holds, take branch") as HTMLSelectElement).value).toBe(
      "b1",
    );
    expect(
      (screen.getByLabelText("When it does not, take branch") as HTMLSelectElement).value,
    ).toBe("b2");
    expect(screen.queryByLabelText("Decision question")).toBeNull();
  });

  it.each([
    ["Value to measure", "subject", "the number of files touched"],
    ["Compared against", "operand", "10"],
  ])(
    "given_aRuleBasedConditional_whenEditing_%s_thenOnlyThatPartOfTheRuleChanges",
    (field, key, value) => {
      const onChange = vi.fn();
      render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={onChange} />);

      fireEvent.change(screen.getByLabelText(field), { target: { value } });

      const before = ruleConditionalNode().data.node as ConditionalData;
      expect(applied(onChange.mock.calls[0][2], before)).toEqual({
        ...before,
        rule: { ...(before.rule as ConditionalRule), [key]: value },
      });
    },
  );

  it("given_aRuleBasedConditional_whenTheRoutingIsChanged_thenTheBranchIdIsWhatIsStored", () => {
    // Ids, not positions or labels: renaming or reordering a branch is an ordinary edit
    // and must not silently invert the routing (ADR-0003).
    const onChange = vi.fn();
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("When it holds, take branch"), {
      target: { value: "b2" },
    });

    const before = ruleConditionalNode().data.node as ConditionalData;
    expect(applied(onChange.mock.calls[0][2], before)).toEqual({
      ...before,
      rule: { ...(before.rule as ConditionalRule), whenTrue: "b2" },
    });
  });

  it("given_aNumericComparisonAgainstSomethingThatIsNotANumber_whenRendered_thenTheDockSaysSoBeforeTheExportDoes", () => {
    render(
      <NodeEditor
        node={ruleConditionalNode({ operand: "a few" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "'a few' is not a whole number, and this comparison needs one — the export is refused until it is.",
      ),
    ).toBeTruthy();
  });

  it("given_aRuleBasedConditional_whenLookingAtTheBranchControls_thenBothAreOfferedWithTheirReason", () => {
    // A rule holds or it does not, so this node decides between exactly two branches —
    // stated, the way both branch bounds are, rather than only enforced at export.
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText("Add branch") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "A rule holds or it does not, so a rule-based conditional decides between exactly two branches.",
      ),
    ).toBeTruthy();
  });

  it("given_aRuleBasedConditionalWithMoreThanTwoBranches_whenRendered_thenTheExtrasCanStillBeRemoved", () => {
    // The dock's job is to offer the way out of a bound, not only to state it. Switching a
    // three-branch conditional to rule-based puts it *over* the two-branch rule, and
    // disabling every remove button left no way back except switching to LLM, trimming, and
    // switching again — the dock refusing to fix what it had just made invalid.
    const node = ruleConditionalNode();
    (node.data.node as ConditionalData).branches = [
      { id: "b1", label: "with trace" },
      { id: "b2", label: "no trace" },
      { id: "b3", label: "maybe" },
    ];
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText("Remove branch maybe") as HTMLButtonElement).disabled).toBe(
      false,
    );
    // Adding is still refused, because the way out of this bound is downwards.
    expect((screen.getByLabelText("Add branch") as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText(
        "A rule holds or it does not, so a rule-based conditional decides between exactly two branches (this one has 3 — remove one).",
      ),
    ).toBeTruthy();
  });

  it("given_aRuleBasedConditionalWithTwoBranches_whenRendered_thenNeitherCanBeRemoved", () => {
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      (screen.getByLabelText("Remove branch with trace") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("given_aNumericComparisonAgainstANumberNoShellAgreesAbout_whenRendered_thenTheDockSaysSo", () => {
    render(
      <NodeEditor
        node={ruleConditionalNode({ operand: "99999999999999999999" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "'99999999999999999999' has more than 9 digits, and a rule is compared by a shell — only numbers up to 999999999 compare the same way everywhere. The export is refused until it does.",
      ),
    ).toBeTruthy();
  });

  it("given_aConditionalWhoseBranchListHoldsSomethingThatIsNotABranch_whenRendered_thenTheDockStillOpens", () => {
    // Unreachable through `deserialize`, which rejects such a file — but the traversal in
    // `workflow-order` guards exactly this shape, and a dock that throws where the rest of
    // the app degrades is an error boundary swallowing the session instead of one node.
    const node = conditionalNode();
    (node.data.node as ConditionalData).branches = [
      { id: "b1", label: "with trace" },
      null as unknown as { id: string; label: string },
    ];

    expect(() =>
      render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />),
    ).not.toThrow();
    expect((screen.getByLabelText("Branch 1 label") as HTMLInputElement).value).toBe(
      "with trace",
    );
  });

  it.each([
    ["a padded numeric operand", " 5", false],
    ["a padded non-number", " five ", true],
  ])(
    "given_%s_whenRendered_thenTheDockWarnsExactlyWhenTheExportWould",
    (_case, operand, warns) => {
      // The dock's verdict and the export's have to be the same verdict: a padded number is
      // a number (`comparedOperand` decides that once, for both), so warning here about a
      // value that exports fine — or staying quiet about one that does not — is the dock
      // disagreeing with the thing it is previewing.
      render(
        <NodeEditor
          node={ruleConditionalNode({ operand })}
          catalog={catalog()}
          onChange={vi.fn()}
        />,
      );

      // Specifically the operand's own warning: a rule-based node always shows the
      // two-branch status line beside it.
      const warnings = screen
        .queryAllByRole("status")
        .map((line) => line.textContent ?? "")
        .filter((text) => text.includes(operand.trim()));
      expect(warnings.length > 0).toBe(warns);
    },
  );

  it("given_aStringComparisonWhoseOperandIsPadded_whenRendered_thenTheDockSaysThePaddingIsPartOfIt", () => {
    // Not an error — ` x ` is a legitimate thing to look for — but it is the one place the
    // author can see it before the export does, and the difference between ` 5` and `5` is
    // invisible in every other rendered surface.
    render(
      <NodeEditor
        node={ruleConditionalNode({ operator: "equals", operand: " 5" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'This compares against " 5" exactly, spaces included. Trim it if you did not mean them.',
      ),
    ).toBeTruthy();
  });

  it("given_aNumericComparison_whenTheComparisonBecomesAStringOne_thenTheOperandStopsCarryingPaddingItWasIgnoring", () => {
    // The dock is where the sequence starts, so it is where the normalization is applied:
    // what is stored after the switch is what was being compared before it.
    const onChange = vi.fn();
    const node = ruleConditionalNode({ operator: "greater-than", operand: " 5" });
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Comparison"), { target: { value: "equals" } });

    const before = ruleConditionalNode({ operator: "greater-than", operand: " 5" }).data
      .node as ConditionalData;
    expect(applied(onChange.mock.calls[0][2], before)).toEqual({
      ...before,
      rule: { ...(before.rule as ConditionalRule), operator: "equals", operand: "5" },
    });
  });

  it("given_aBranchListHoldingSomethingThatIsNotABranch_whenAnotherBranchIsEditedOrRemoved_thenNothingThrows", () => {
    // The write side of the same tolerance the render side has: a handler that dereferences
    // `.id` on every entry would throw on the *good* branch's own button, which is the one
    // the user can actually reach.
    const onChange = vi.fn();
    const node = conditionalNode();
    (node.data.node as ConditionalData).branches = [
      { id: "b1", label: "with trace" },
      null as unknown as { id: string; label: string },
      { id: "b2", label: "no trace" },
    ];
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    expect(() =>
      fireEvent.change(screen.getByLabelText("Branch 1 label"), {
        target: { value: "renamed" },
      }),
    ).not.toThrow();
    expect(() =>
      fireEvent.click(screen.getByLabelText("Remove branch with trace")),
    ).not.toThrow();

    // Applied against the list **as it actually is** — the malformed entry included — since
    // the edit is an updater over the node's current data, which is where a handler that
    // dereferences every entry would actually throw.
    const current = () =>
      ({
        ...(conditionalNode().data.node as ConditionalData),
        branches: [
          { id: "b1", label: "with trace" },
          null as unknown as { id: string; label: string },
          { id: "b2", label: "no trace" },
        ],
      }) as ConditionalData;

    const renamed = applied(onChange.mock.calls[0][2], current()) as ConditionalData;
    expect(renamed.branches[0]).toEqual({ id: "b1", label: "renamed" });
    const removed = applied(onChange.mock.calls[1][2], current()) as ConditionalData;
    expect(removed.branches.some((b) => b?.id === "b1")).toBe(false);
    // Untouched entries survive, including the one nothing can address.
    expect(removed.branches).toHaveLength(2);
  });

  it("given_aRuleBasedConditional_whenRendered_thenItSaysWhoDecidesAtRunTime", () => {
    render(<NodeEditor node={ruleConditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      screen.getByText(
        "Claude Code measures the value above and the control scaffold exported with this workflow compares it, so the same measured value always takes the same branch.",
      ),
    ).toBeTruthy();
  });
});

describe("NodeEditor — the max-iteration guard of a loop gate", () => {
  const GUARD = "Max passes, when a branch loops back";

  it("given_aConditionalNode_whenRendered_thenTheGuardIsOfferedAndEmpty", () => {
    // Offered on every conditional, because whether this node is a loop gate depends on
    // where an edge goes and the dock only sees the node — and empty, because a bound
    // nobody chose is precisely what an unguarded loop is.
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText(GUARD) as HTMLInputElement).value).toBe("");
  });

  it("given_aGuardTyped_whenEdited_thenItIsStoredAsANumberAndNothingElseChanges", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={conditionalNode()} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(GUARD), { target: { value: "4" } });

    expect(applied(onChange.mock.calls[0][2], conditionalNode().data.node)).toEqual({
      mode: "llm",
      question: "Does the report contain a stack trace?",
      maxIterations: 4,
      branches: [
        { id: "b1", label: "with trace" },
        { id: "b2", label: "no trace" },
      ],
    });
  });

  it("given_aGuardedConditional_whenTheGuardIsCleared_thenTheFieldIsRemovedRatherThanZeroed", () => {
    // No guard and a guard of nothing are different documents, and only one of them
    // exports: clearing the field has to produce the first.
    const node = conditionalNode();
    (node.data.node as ConditionalData).maxIterations = 4;
    const onChange = vi.fn();
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(GUARD), { target: { value: "" } });

    expect(applied(onChange.mock.calls[0][2], node.data.node)).not.toHaveProperty(
      "maxIterations",
    );
  });

  it("given_aGuardedConditional_whenRendered_thenTheStoredGuardIsShown", () => {
    const node = conditionalNode();
    (node.data.node as ConditionalData).maxIterations = 7;
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect((screen.getByLabelText(GUARD) as HTMLInputElement).value).toBe("7");
  });

  it("given_aGuardThatCouldNotStopALoop_whenRendered_thenTheDockSaysSoBeforeTheExportDoes", () => {
    // The dock's verdict is the validator's, through `loopGuardOf`: "the export was
    // refused" is a poor place to learn that a loop's bound has to be a whole number.
    const node = conditionalNode();
    (node.data.node as ConditionalData).maxIterations = 0;
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect(
      screen.getByText(/is not a number of passes a loop can be stopped at/),
    ).toBeTruthy();
  });

  it("given_aUsableGuard_whenRendered_thenNothingIsFlagged", () => {
    const node = conditionalNode();
    (node.data.node as ConditionalData).maxIterations = 3;
    render(<NodeEditor node={node} catalog={catalog()} onChange={vi.fn()} />);

    expect(screen.queryByText(/is not a number of passes/)).toBeNull();
  });
});
