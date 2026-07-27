import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_ROOTS,
  MAX_SOURCE_ROOTS,
  addSourceRoot,
  parseSourceRoots,
  removeSourceRoot,
  serializeSourceRoots,
  sourceRootId,
  tildeify,
} from "./source-roots";

describe("source roots — default configuration", () => {
  it("given_noConfiguration_thenPersonalClaudeRootIsScannedByDefault", () => {
    expect(DEFAULT_SOURCE_ROOTS).toEqual([
      { id: "personal:~/.claude", path: "~/.claude", role: "personal" },
    ]);
  });

  it("given_missingPersistedConfiguration_whenParsed_thenDefaultsAreUsed", () => {
    expect(parseSourceRoots(null)).toEqual([...DEFAULT_SOURCE_ROOTS]);
  });
});

describe("addSourceRoot", () => {
  it("given_projectRootPath_whenAdded_thenItIsAppendedAfterTheDefault", () => {
    const roots = addSourceRoot(DEFAULT_SOURCE_ROOTS, "/work/app/.claude", "project");

    expect(roots).toHaveLength(2);
    expect(roots[1]).toEqual({
      id: "project:/work/app/.claude",
      path: "/work/app/.claude",
      role: "project",
    });
  });

  it("given_sameRootTwice_whenAdded_thenItIsNotDuplicated", () => {
    const once = addSourceRoot(DEFAULT_SOURCE_ROOTS, "/work/.claude", "project");

    expect(addSourceRoot(once, "/work/.claude/", "project")).toEqual(once);
  });

  it("given_samePathWithADifferentRole_whenAdded_thenItIsATrulyDistinctRoot", () => {
    const roots = addSourceRoot(
      addSourceRoot([], "/work/.claude", "project"),
      "/work/.claude",
      "personal",
    );

    expect(roots.map((r) => r.id)).toEqual([
      "project:/work/.claude",
      "personal:/work/.claude",
    ]);
  });

  it("given_blankPath_whenAdded_thenNothingChanges", () => {
    expect(addSourceRoot(DEFAULT_SOURCE_ROOTS, "   ", "project")).toEqual([
      ...DEFAULT_SOURCE_ROOTS,
    ]);
  });

  it("given_roots_whenAdding_thenTheInputArrayIsNotMutated", () => {
    const roots = [...DEFAULT_SOURCE_ROOTS];

    addSourceRoot(roots, "/work/.claude", "project");

    expect(roots).toHaveLength(1);
  });
});

describe("removeSourceRoot", () => {
  it("given_configuredRoot_whenRemoved_thenItIsGone", () => {
    const roots = addSourceRoot(DEFAULT_SOURCE_ROOTS, "/work/.claude", "project");

    expect(removeSourceRoot(roots, "project:/work/.claude")).toEqual([
      ...DEFAULT_SOURCE_ROOTS,
    ]);
  });
});

describe("sourceRootId", () => {
  it("given_rolePlusPath_thenIdIsStableAndSymbolic", () => {
    expect(sourceRootId("personal", "~/.claude")).toBe("personal:~/.claude");
    expect(sourceRootId("personal", "~/.claude/")).toBe("personal:~/.claude");
  });
});

describe("persisting the configuration", () => {
  it("given_configuredRoots_whenRoundTripped_thenTheyAreRestored", () => {
    const roots = addSourceRoot(DEFAULT_SOURCE_ROOTS, "/work/.claude", "project");

    expect(parseSourceRoots(serializeSourceRoots(roots))).toEqual(roots);
  });

  it.each(["not json", "42", "[]", '[{"nope":true}]'])(
    "given_unusablePersistedValue_%s_whenParsed_thenDefaultsAreUsed",
    (stored) => {
      expect(parseSourceRoots(stored)).toEqual([...DEFAULT_SOURCE_ROOTS]);
    },
  );

  it("given_persistedRootsWithOneBadEntry_whenParsed_thenTheGoodOnesSurvive", () => {
    // The surviving entry is deliberately NOT the default, so this cannot pass
    // by falling back to the defaults.
    const good = { id: "project:/work/.claude", path: "/work/.claude", role: "project" };
    const stored = JSON.stringify([good, { id: "broken", path: "/x", role: "plugin" }]);

    expect(parseSourceRoots(stored)).toEqual([good]);
  });
});

describe("root identity is normalized, so one directory is one root", () => {
  it("given_thePickedAbsolutePathOfTheDefaultRoot_whenTildeified_thenItIsTheSameRoot", () => {
    const picked = tildeify("/Users/me/.claude", "/Users/me");

    expect(picked).toBe("~/.claude");
    expect(addSourceRoot(DEFAULT_SOURCE_ROOTS, picked, "personal")).toEqual([
      ...DEFAULT_SOURCE_ROOTS,
    ]);
  });

  it.each([
    ["the home directory itself", "/Users/me", "~"],
    ["a trailing separator", "/Users/me/.claude/", "~/.claude"],
    ["a nested project root", "/Users/me/work/app/.claude", "~/work/app/.claude"],
    ["a path outside home", "/opt/shared/.claude", "/opt/shared/.claude"],
    ["a home-prefixed sibling", "/Users/mexico/.claude", "/Users/mexico/.claude"],
  ])("given_%s_whenTildeified_thenItIs_%s", (_case, path, expected) => {
    expect(tildeify(path, "/Users/me")).toBe(expected);
  });

  it("given_noKnownHomeDirectory_whenTildeified_thenThePathIsMerelyNormalized", () => {
    expect(tildeify("/Users/me/.claude/", null)).toBe("/Users/me/.claude");
  });

  it.each([
    ["a trailing separator", "~/.claude/"],
    ["a doubled separator", "~//.claude"],
    ["surrounding whitespace", "  ~/.claude  "],
  ])("given_%s_whenAdded_thenItIsNotASecondRoot", (_case, path) => {
    expect(addSourceRoot(DEFAULT_SOURCE_ROOTS, path, "personal")).toEqual([
      ...DEFAULT_SOURCE_ROOTS,
    ]);
  });

  it("given_moreRootsThanTheLimit_whenAdding_thenTheLimitHolds", () => {
    let roots = [...DEFAULT_SOURCE_ROOTS];
    for (let i = 0; i < MAX_SOURCE_ROOTS + 5; i += 1) {
      roots = addSourceRoot(roots, `/work/${i}/.claude`, "project");
    }

    expect(roots).toHaveLength(MAX_SOURCE_ROOTS);
  });

  it("given_persistedDuplicateIds_whenParsed_thenTheyAreDeduplicated", () => {
    const stored = JSON.stringify([
      { id: "personal:~/.claude", path: "~/.claude", role: "personal" },
      { id: "personal:~/.claude", path: "~/.claude/", role: "personal" },
    ]);

    expect(parseSourceRoots(stored)).toEqual([...DEFAULT_SOURCE_ROOTS]);
  });

  it("given_aPersistedWhitespaceOnlyPath_whenParsed_thenItIsDropped", () => {
    const stored = JSON.stringify([
      { id: "project:  ", path: "   ", role: "project" },
      { id: "project:/work/.claude", path: "/work/.claude", role: "project" },
    ]);

    expect(parseSourceRoots(stored)).toEqual([
      { id: "project:/work/.claude", path: "/work/.claude", role: "project" },
    ]);
  });

  it("given_aPersistedStaleId_whenParsed_thenTheIdIsRecomputedFromRoleAndPath", () => {
    const stored = JSON.stringify([
      { id: "whatever-was-stored", path: "/work/.claude/", role: "project" },
    ]);

    expect(parseSourceRoots(stored)).toEqual([
      { id: "project:/work/.claude", path: "/work/.claude", role: "project" },
    ]);
  });

  it("given_aHugePersistedArray_whenParsed_thenItIsBounded", () => {
    const stored = JSON.stringify(
      Array.from({ length: 500 }, (_, i) => ({
        id: `project:/work/${i}`,
        path: `/work/${i}`,
        role: "project",
      })),
    );

    expect(parseSourceRoots(stored)).toHaveLength(MAX_SOURCE_ROOTS);
  });
});
