// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PatchNode } from "../canvas/react-flow-adapter";
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

function skillNode(name = ""): PatchNode {
  return {
    id: "n2",
    type: "skill",
    position: { x: 0, y: 0 },
    data: { label: "Skill", node: { name, rootId: name === "" ? "" : PERSONAL.id } },
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

    expect(onChange).toHaveBeenCalledWith("n2", "Skill", {
      name: "tdd",
      rootId: "personal:~/.claude",
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

describe("NodeEditor — unbinding", () => {
  it("given_boundNode_whenThePlaceholderIsSelected_thenTheReferenceIsCleared", () => {
    const onChange = vi.fn();
    render(<NodeEditor node={skillNode("tdd")} catalog={catalog()} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "" },
    });

    expect(onChange).toHaveBeenCalledWith("n2", "Skill", { name: "", rootId: "" });
  });

  it("given_unresolvedNode_whenRepickedFromTheCatalog_thenItRebinds", () => {
    const onChange = vi.fn();
    render(
      <NodeEditor node={skillNode("moved-away")} catalog={catalog()} onChange={onChange} />,
    );

    fireEvent.change(screen.getByLabelText("Imported skill"), {
      target: { value: "tdd" },
    });

    expect(onChange).toHaveBeenCalledWith("n2", "Skill", {
      name: "tdd",
      rootId: "personal:~/.claude",
    });
  });
});
