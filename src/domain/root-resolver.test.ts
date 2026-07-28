import { describe, expect, it } from "vitest";
import {
  findResolved,
  resolveListings,
  type ArtifactListing,
} from "./root-resolver";

/** Build a synthetic listing — no filesystem is involved anywhere here. */
function listing(
  rootId: string,
  role: ArtifactListing["role"],
  kind: ArtifactListing["kind"],
  name: string,
): ArtifactListing {
  return { rootId, role, kind, name };
}

const personalSkill = listing("personal", "personal", "skill", "tdd");
const projectSkill = listing("project", "project", "skill", "tdd");
const personalAgent = listing("personal", "personal", "agent", "reviewer");
const projectAgent = listing("project", "project", "agent", "reviewer");

describe("resolveListings — Claude Code precedence", () => {
  it.each([
    ["personal listed first", [personalSkill, projectSkill]],
    ["project listed first", [projectSkill, personalSkill]],
  ])(
    "given_skillInBothRoots_with_%s_whenResolving_thenPersonalWins",
    (_name, listings) => {
      const resolution = resolveListings(listings);

      expect(resolution.entries).toHaveLength(1);
      expect(resolution.entries[0].winner.rootId).toBe("personal");
      expect(resolution.entries[0].shadowed.map((l) => l.rootId)).toEqual([
        "project",
      ]);
    },
  );

  it.each([
    ["personal listed first", [personalAgent, projectAgent]],
    ["project listed first", [projectAgent, personalAgent]],
  ])(
    "given_agentInBothRoots_with_%s_whenResolving_thenProjectWins",
    (_name, listings) => {
      const resolution = resolveListings(listings);

      expect(resolution.entries).toHaveLength(1);
      expect(resolution.entries[0].winner.rootId).toBe("project");
      expect(resolution.entries[0].shadowed.map((l) => l.rootId)).toEqual([
        "personal",
      ]);
    },
  );

  it("given_skillsAndAgentsColliding_whenResolving_thenPrecedenceIsOppositePerKind", () => {
    const resolution = resolveListings([
      personalSkill,
      projectSkill,
      personalAgent,
      projectAgent,
    ]);

    expect(findResolved(resolution, "skill", "tdd")?.winner.role).toBe("personal");
    expect(findResolved(resolution, "agent", "reviewer")?.winner.role).toBe(
      "project",
    );
  });

  it("given_sameNameAsSkillAndAgent_whenResolving_thenTheyDoNotCollide", () => {
    const resolution = resolveListings([
      listing("personal", "personal", "skill", "review"),
      listing("personal", "personal", "agent", "review"),
    ]);

    expect(resolution.entries).toHaveLength(2);
    expect(resolution.collisions).toEqual([]);
  });

  it("given_twoRootsOfTheSameRole_whenResolving_thenTheFirstListedRootWins", () => {
    const resolution = resolveListings([
      listing("project-a", "project", "skill", "tdd"),
      listing("project-b", "project", "skill", "tdd"),
    ]);

    expect(resolution.entries[0].winner.rootId).toBe("project-a");
    expect(resolution.entries[0].shadowed.map((l) => l.rootId)).toEqual([
      "project-b",
    ]);
  });

  it("given_threeWayCollision_whenResolving_thenShadowedAreOrderedByPrecedence", () => {
    const resolution = resolveListings([
      listing("project-a", "project", "skill", "tdd"),
      listing("project-b", "project", "skill", "tdd"),
      personalSkill,
    ]);

    const entry = resolution.entries[0];
    expect(entry.winner.rootId).toBe("personal");
    expect(entry.shadowed.map((l) => l.rootId)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("given_noCollisions_whenResolving_thenEveryListingWinsAndNothingIsReported", () => {
    const resolution = resolveListings([personalSkill, projectAgent]);

    expect(resolution.entries.map((e) => e.winner)).toEqual([
      personalSkill,
      projectAgent,
    ]);
    expect(resolution.collisions).toEqual([]);
  });

  it("given_emptyListings_whenResolving_thenResolutionIsEmpty", () => {
    expect(resolveListings([])).toEqual({ entries: [], collisions: [] });
  });

  it("given_collision_whenResolving_thenItIsSurfacedWithWinnerAndShadowed", () => {
    const resolution = resolveListings([projectSkill, personalSkill]);

    expect(resolution.collisions).toHaveLength(1);
    const collision = resolution.collisions[0];
    expect(collision.kind).toBe("skill");
    expect(collision.name).toBe("tdd");
    expect(collision.winner).toEqual(personalSkill);
    expect(collision.shadowed).toEqual([projectSkill]);
  });

  it("given_listings_whenResolving_thenEntriesKeepFirstAppearanceOrder", () => {
    const resolution = resolveListings([
      listing("personal", "personal", "skill", "zebra"),
      listing("personal", "personal", "skill", "alpha"),
    ]);

    expect(resolution.entries.map((e) => e.name)).toEqual(["zebra", "alpha"]);
  });

  it("given_richerListingType_whenResolving_thenTheOriginalObjectIsReturned", () => {
    const enriched = { ...personalSkill, path: "/home/me/.claude/skills/tdd" };

    const resolution = resolveListings([enriched, projectSkill]);

    expect(resolution.entries[0].winner.path).toBe("/home/me/.claude/skills/tdd");
  });
});

describe("findResolved", () => {
  it("given_unknownName_whenLookedUp_thenUndefined", () => {
    const resolution = resolveListings([personalSkill]);

    expect(findResolved(resolution, "skill", "nope")).toBeUndefined();
  });

  it("given_knownNameOfTheOtherKind_whenLookedUp_thenUndefined", () => {
    const resolution = resolveListings([personalSkill]);

    expect(findResolved(resolution, "agent", "tdd")).toBeUndefined();
  });
});
