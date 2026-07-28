// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PatchNode } from "../canvas/react-flow-adapter";
import type { ExportMode, NodeData } from "../domain/graph-document";
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
