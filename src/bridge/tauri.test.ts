/**
 * The bridge is a thin shell, but one piece of behaviour lives here and nowhere
 * else: the picked source-root path is rewritten to its `~`-relative form. This is
 * the only place that knows the home directory, and without it the default
 * `~/.claude` root and a picked `/Users/me/.claude` become two roots over one
 * directory — the defect the pure normalization alone cannot prevent.
 */
import { describe, expect, it, vi } from "vitest";

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const path = vi.hoisted(() => ({ homeDir: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("@tauri-apps/api/path", () => path);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { pickSourceRoot } = await import("./tauri");

describe("pickSourceRoot", () => {
  it("given_aPickedPathInsideHome_whenReturned_thenItIsTildeRelative", async () => {
    dialog.open.mockResolvedValue("/Users/me/.claude");
    path.homeDir.mockResolvedValue("/Users/me");

    expect(await pickSourceRoot()).toBe("~/.claude");
  });

  it("given_aPickedProjectRootInsideHome_whenReturned_thenOnlyTheHomePrefixIsRewritten", async () => {
    dialog.open.mockResolvedValue("/Users/me/work/app/.claude");
    path.homeDir.mockResolvedValue("/Users/me/");

    expect(await pickSourceRoot()).toBe("~/work/app/.claude");
  });

  it("given_aPickedPathOutsideHome_whenReturned_thenItIsUnchanged", async () => {
    dialog.open.mockResolvedValue("/opt/shared/.claude");
    path.homeDir.mockResolvedValue("/Users/me");

    expect(await pickSourceRoot()).toBe("/opt/shared/.claude");
  });

  it("given_theHomeDirectoryIsUnavailable_whenReturned_thenTheRawPathIsStillUsable", async () => {
    dialog.open.mockResolvedValue("/Users/me/.claude");
    path.homeDir.mockRejectedValue(new Error("no home"));

    expect(await pickSourceRoot()).toBe("/Users/me/.claude");
  });

  it("given_theUserCancels_whenReturned_thenNull", async () => {
    dialog.open.mockResolvedValue(null);

    expect(await pickSourceRoot()).toBeNull();
  });
});
