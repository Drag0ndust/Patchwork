// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PatchNode } from "../canvas/react-flow-adapter";
import {
  branchesWithinLimit,
  DEFAULT_RULE_OPERATOR,
  MAX_BRANCHES_PER_CONDITIONAL,
  type ArtifactRefData,
  type AuthoredArtifactData,
  type ConditionalData,
  type ConditionalRule,
  type ExportMode,
  type NodeData,
} from "../domain/graph-document";
import { artifactScaffold } from "../domain/artifact-scaffold";
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

/** A `skill`/`agent` node whose artifact was written in the graph. */
function authoredNode(
  kind: "skill" | "agent",
  data: Partial<AuthoredArtifactData> = {},
  label = "Triage",
): PatchNode {
  return {
    id: "n2",
    type: kind,
    position: { x: 0, y: 0 },
    data: {
      label,
      node: {
        source: "authored",
        description: "Triage a report.",
        body: "# Triage\n\nRead it.\n",
        ...data,
      } as AuthoredArtifactData,
    },
  };
}

/** The `<details>` panel the fuller frontmatter surface is folded into. */
function advancedPanel(container: HTMLElement): HTMLDetailsElement {
  const panel = container.querySelector("details");
  if (!panel) throw new Error("the dock has no Advanced panel");
  return panel as HTMLDetailsElement;
}

describe("NodeEditor — where a node's artifact comes from", () => {
  it("given_anImportedNode_whenRendered_thenBothWaysToGetAnArtifactAreOffered", () => {
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={vi.fn()} />);

    const picker = screen.getByLabelText("Artifact") as HTMLSelectElement;
    expect(picker.value).toBe("imported");
    expect([...picker.options].map((o) => o.value)).toEqual(["imported", "authored"]);
  });

  it("given_anImportedNode_whenSwitchedToAuthored_thenTheEditorIsSeededWithATypeSpecificScaffold", () => {
    // AC3: no blank slate. The hard part of writing a skill is knowing its shape, and
    // the scaffold is the answer to that — see `artifactScaffold`.
    const onChange = vi.fn();
    render(
      <NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Artifact"), {
      target: { value: "authored" },
    });

    const next = applied(onChange.mock.calls[0][2], {
      name: "tdd",
      rootId: PERSONAL.id,
      exportMode: "reference",
    }) as AuthoredArtifactData;
    expect(next.source).toBe("authored");
    expect(next.body).toBe(artifactScaffold("skill", "Skill"));
    // Never the imported artifact's name: the two mean different things, and
    // inheriting one would author a second artifact claiming an installed one's name.
    expect(next.name).toBe("");
  });

  it("given_anAuthoredNodeWithProseAlready_whenSwitchedAwayAndBack_thenTheBodyIsNotOverwritten", () => {
    // The scaffold is a starting point, not a reset: re-seeding over a written body
    // would lose the work to a mis-click on a select.
    const onChange = vi.fn();
    render(
      <NodeEditor
        node={{
          ...skillNode("tdd"),
          data: {
            label: "Skill",
            node: {
              name: "tdd",
              rootId: PERSONAL.id,
              exportMode: "reference",
              description: "Triage a report.",
              body: "# Mine\n\nWhat I wrote.\n",
            } as NodeData,
          },
        }}
        catalog={catalog()}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Artifact"), {
      target: { value: "authored" },
    });

    const next = applied(onChange.mock.calls[0][2], {
      name: "tdd",
      rootId: PERSONAL.id,
      exportMode: "reference",
      description: "Triage a report.",
      body: "# Mine\n\nWhat I wrote.\n",
    } as NodeData) as AuthoredArtifactData;
    expect(next.body).toBe("# Mine\n\nWhat I wrote.\n");
    expect(next.description).toBe("Triage a report.");
  });

  it("given_anAuthoredNode_whenSwitchedBackToImported_thenItIsUnboundAndTheProseIsKept", () => {
    const onChange = vi.fn();
    render(
      <NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Artifact"), {
      target: { value: "imported" },
    });

    const next = applied(
      onChange.mock.calls[0][2],
      authoredNode("skill").data.node,
    ) as ArtifactRefData & { body?: string };
    expect(next.source).toBe("imported");
    expect(next.name).toBe("");
    expect(next.rootId).toBe("");
    expect(next.body).toBe("# Triage\n\nRead it.\n");
  });

  it("given_anImportedNodeCarryingNonTextFields_whenSwitchedToAuthored_thenItReadsThemAsEmptyRatherThanThrowing", () => {
    // `assertNodeShape` deliberately leaves an *imported* node's carried-over authoring
    // fields untyped — that is what lets a switch back survive — so a hand-edited file
    // holding a number where prose belongs opens cleanly and arrives here. The dock is
    // the first surface that reads them as prose, and it degrades like every other one
    // (issue #27): not text is a field with nothing in it.
    const onChange = vi.fn();
    const stray = {
      name: "x",
      rootId: PERSONAL.id,
      exportMode: "reference",
      body: 42,
      description: { was: "an object" },
      tools: ["Read"],
      model: 7,
      effort: null,
    } as unknown as NodeData;
    render(
      <NodeEditor
        node={{ ...skillNode("tdd"), data: { label: "Skill", node: stray } }}
        catalog={catalog()}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Artifact"), {
      target: { value: "authored" },
    });

    const next = applied(onChange.mock.calls[0][2], stray) as AuthoredArtifactData;
    expect(next.source).toBe("authored");
    expect(next.description).toBe("");
    // Nothing usable was carried, so this is the blank slate the scaffold is for.
    expect(next.body).toBe(artifactScaffold("skill", "Skill"));
    // Carried as text or not at all: a number left in `tools` would make the document
    // this produced unopenable the next time it was saved.
    expect(next.tools).toBe("");
    expect(next.model).toBe("");
    expect(next.effort).toBe("");
  });

  it("given_anAuthoredNodeCarryingAnExportModeThatIsNotOne_whenSwitchedToImported_thenAUsableModeIsWrittenBack", () => {
    // An authored node's carried `exportMode` is not type-checked when the document is
    // opened (there is no export choice to make while it is authored), and this is the
    // transform that puts it back into the shape where it *is* checked. Writing the
    // junk value on would produce a document the app itself could not reopen.
    const onChange = vi.fn();
    const node = authoredNode("skill", {
      exportMode: 42,
    } as unknown as Partial<AuthoredArtifactData>);
    render(<NodeEditor node={node} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "imported" } });

    const next = applied(onChange.mock.calls[0][2], node.data.node) as ArtifactRefData;
    expect(next.exportMode).toBe("reference");
  });

  it("given_anAuthoredNodeWithAName_whenSwitchedAwayAndBack_thenTheNameIsNotCarriedBack", () => {
    // Deliberate, and the one field of the six that does not round-trip: an imported
    // node's `name` is its binding to an installed artifact, so there is nowhere in that
    // shape to park an authored name — parking it in a second key would put a field in
    // every saved document whose only job is undoing a select. See `ArtifactRefData`.
    const onChange = vi.fn();
    const authored = authoredNode("skill", { name: "三分法", tools: "Read" });
    const { rerender } = render(
      <NodeEditor node={authored} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "imported" } });
    const imported = applied(onChange.mock.calls[0][2], authored.data.node);

    rerender(
      <NodeEditor
        node={{ ...authored, data: { label: "Triage", node: imported } }}
        catalog={catalog()}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Artifact"), { target: { value: "authored" } });
    const back = applied(onChange.mock.calls[1][2], imported) as AuthoredArtifactData;

    expect(back.name).toBe("");
    // Everything else the author wrote does come home.
    expect(back.body).toBe("# Triage\n\nRead it.\n");
    expect(back.description).toBe("Triage a report.");
    expect(back.tools).toBe("Read");
  });

  it("given_anAuthoredNode_whenRendered_thenTheImportedPickerAndTheExportChoiceAreNotOffered", () => {
    // There is nothing to pick and nothing to choose: an authored artifact has no
    // original to reference, so it is always written into the bundle.
    render(<NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={vi.fn()} />);

    expect(screen.queryByLabelText("Imported skill")).toBeNull();
    expect(screen.queryByLabelText("On export")).toBeNull();
    expect(screen.getByText(/always written into the exported bundle/)).toBeTruthy();
  });
});

describe("NodeEditor — authoring a skill or an agent from the node", () => {
  it("given_anAuthoredSkill_whenRendered_thenTheOnlyFieldsInFrontOfTheAuthorAreTheOnesItNeeds", () => {
    // AC1: the minimal skill is a description (and the prose). Its *name* is derived
    // from the node's label, so it sits in Advanced as an override — ADR-0007.
    const { container } = render(
      <NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={vi.fn()} />,
    );
    const advanced = advancedPanel(container);

    expect(advanced.contains(screen.getByLabelText("Description"))).toBe(false);
    expect(advanced.contains(screen.getByLabelText("Instructions"))).toBe(false);
    expect(advanced.contains(screen.getByLabelText("Name"))).toBe(true);
  });

  it("given_anAuthoredAgent_whenRendered_thenItsNameIsAskedForUpFront", () => {
    // An agent *is* the file `agents/<name>.md`, so nothing else in the graph says
    // what it is called.
    const { container } = render(
      <NodeEditor
        node={authoredNode("agent", { name: "report-reviewer" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(advancedPanel(container).contains(screen.getByLabelText("Name"))).toBe(false);
  });

  it("given_anAuthoredNode_whenRendered_thenTheAdvancedFrontmatterIsFoldedAwayButPresent", () => {
    // AC2: progressive disclosure — the fuller surface is one click away, not in the
    // way of the two fields most artifacts only ever set.
    const { container } = render(
      <NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={vi.fn()} />,
    );
    const advanced = advancedPanel(container);

    expect(advanced.open).toBe(false);
    for (const field of ["Tools", "Model", "Effort"]) {
      expect(advanced.contains(screen.getByLabelText(field))).toBe(true);
    }
  });

  it.each([
    ["Description", "description", "What it does."],
    ["Instructions", "body", "# New\n"],
    ["Name", "name", "bug-triage"],
    ["Tools", "tools", "Read, Grep"],
    ["Model", "model", "opus"],
    ["Effort", "effort", "high"],
  ])(
    "given_theAuthored_%s_field_whenEdited_thenOnlyThatFieldChanges",
    (fieldLabel, key, value) => {
      const onChange = vi.fn();
      render(
        <NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={onChange} />,
      );

      fireEvent.change(screen.getByLabelText(fieldLabel), { target: { value } });

      const current = authoredNode("skill").data.node;
      const next = applied(onChange.mock.calls[0][2], current) as Record<string, unknown>;
      expect(next[key]).toBe(value);
      expect({ ...next, [key]: undefined }).toEqual({
        ...(current as Record<string, unknown>),
        [key]: undefined,
      });
    },
  );

  it("given_anAuthoredSkill_whenRendered_thenItSaysWhereTheArtifactWillBeWritten", () => {
    // The derived name is only trustworthy if it is visible: it comes off the node's
    // label, and this is the one place that says what that produced.
    render(
      <NodeEditor
        node={authoredNode("skill", {}, "Bug Triage")}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("skills/bug-triage/SKILL.md")).toBeTruthy();
  });

  it("given_anAuthoredAgent_whenRendered_thenItSaysWhereTheArtifactWillBeWritten", () => {
    render(
      <NodeEditor
        node={authoredNode("agent", { name: "report-reviewer" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("agents/report-reviewer.md")).toBeTruthy();
  });
});

describe("NodeEditor — live validation of an authored artifact", () => {
  it("given_anAuthoredSkillWithNoDescription_whenRendered_thenTheProblemIsSurfacedAsItIsTyped", () => {
    // AC4, and the reason it is here rather than only at export: a required field
    // nobody mentioned until the export button is a field discovered too late.
    render(
      <NodeEditor
        node={authoredNode("skill", { description: "" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/no description/)).toBeTruthy();
  });

  it("given_anAuthoredAgentWithNoName_whenRendered_thenTheProblemIsSurfaced", () => {
    render(
      <NodeEditor
        node={authoredNode("agent", { name: "" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/with no name/)).toBeTruthy();
  });

  it("given_anAuthoredNameThatCollidesWithAnInstalledArtifact_whenRendered_thenTheClashIsNamedBeforeItIsWritten", () => {
    // Collision-at-write: `tdd` is in the catalog's personal root.
    render(
      <NodeEditor
        node={authoredNode("skill", { name: "tdd" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/already in your source roots/)).toBeTruthy();
  });

  it("given_twoAuthoredNodesClaimingOneName_whenRendered_thenTheOtherNodeIsNamed", () => {
    // They would be written to one file inside the bundle, so only one can have it.
    render(
      <NodeEditor
        node={authoredNode("skill", { name: "triage" })}
        nodes={[
          authoredNode("skill", { name: "triage" }),
          { ...authoredNode("skill", { name: "triage" }), id: "n7" },
        ]}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/node 'n7'/)).toBeTruthy();
  });

  it("given_anAuthoredSkillWhoseLabelSlugsToNothing_whenRendered_thenTheDockSaysSoRatherThanShowingAPath", () => {
    // A label in a non-Latin script produced no name at all, and the dock used to show
    // `skills/workflow/SKILL.md` for it — a path the author never asked for, under a
    // name they never typed.
    const { container } = render(
      <NodeEditor
        node={authoredNode("skill", {}, "\u4e2d\u6587")}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(container.textContent).not.toContain("skills/workflow/SKILL.md");
    expect(screen.getByText(/has no letters or digits a file name can be built from/)).toBeTruthy();
  });

  it("given_anAuthoredNameCarryingItsOwnNamespace_whenRendered_thenNoPathIsPromisedForIt", () => {
    // The dock and the export must not disagree: `validateGraph` refuses this name, so
    // showing where it would land would be promising a file that is never written.
    const { container } = render(
      <NodeEditor
        node={authoredNode("skill", { name: "coding:tdd" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(container.textContent).not.toContain("skills/coding/skills/tdd/SKILL.md");
    expect(screen.getByText(/nowhere in the bundle to write this/)).toBeTruthy();
  });

  it("given_anAuthoredAgentNamedSKILL_whenRendered_thenNoPathIsPromisedAndTheRefusalIsShownLive", () => {
    // `agents/SKILL.md` is not an artifact under the layout rule, so the export refuses
    // it. The dock used to print "Exported as `agents/SKILL.md`" all the same, and the
    // refusal only arrived on the export click.
    const { container } = render(
      <NodeEditor
        node={authoredNode("agent", { name: "SKILL" })}
        catalog={catalog()}
        onChange={vi.fn()}
      />,
    );

    expect(container.querySelector(".pw-ref code")).toBeNull();
    expect(screen.getByText(/nowhere in the bundle to write this/)).toBeTruthy();
    expect(screen.getByText(/would not be discoverable/)).toBeTruthy();
  });

  it("given_anAuthoredNameTooLongForTheWorkflowsNamespace_whenRendered_thenNoPathIsPromisedAndTheRefusalIsShownLive", () => {
    // The dock is handed the workflow name for exactly this: the invocation is
    // `<bundleDir>:<name>`, and a 64-character directory plus a 64-character name is a
    // name Claude Code cannot resolve — which the dock cannot know on its own.
    const { container } = render(
      <NodeEditor
        node={authoredNode("agent", { name: "a".repeat(64) })}
        catalog={catalog()}
        workflowName={"w".repeat(54)}
        onChange={vi.fn()}
      />,
    );

    expect(container.textContent).not.toContain(`agents/${"a".repeat(64)}.md`);
    expect(screen.getByText(/would be invoked as/)).toBeTruthy();
  });

  it("given_theSameNameUnderAShortWorkflowName_whenRendered_thenThePathIsPromisedAgain", () => {
    const { container } = render(
      <NodeEditor
        node={authoredNode("agent", { name: "a".repeat(64) })}
        catalog={catalog()}
        workflowName="Triage"
        onChange={vi.fn()}
      />,
    );

    expect(container.textContent).toContain(`agents/${"a".repeat(64)}.md`);
  });

  it("given_aValidAuthoredArtifact_whenRendered_thenNothingIsFlagged", () => {
    const { container } = render(
      <NodeEditor node={authoredNode("skill")} catalog={catalog()} onChange={vi.fn()} />,
    );

    expect(container.querySelectorAll(".pw-ref--unresolved")).toHaveLength(0);
  });

  it("given_anAuthoredArtifactInEveryStateOfHalfFinished_whenRendered_thenTypingIsNeverRefusedAndNothingThrows", () => {
    // Validation surfaces problems; it never blocks input, and it never takes the
    // session to the error boundary for a field that is mid-edit.
    for (const data of [
      { description: "", body: "", name: "" },
      { name: "not a name" },
      { name: "a".repeat(200) },
      { description: "   ", body: "   " },
    ]) {
      const onChange = vi.fn();
      const { unmount } = render(
        <NodeEditor
          node={authoredNode("agent", data)}
          catalog={catalog()}
          onChange={onChange}
        />,
      );

      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "Something." },
      });
      expect(onChange).toHaveBeenCalled();
      unmount();
    }
  });
});
