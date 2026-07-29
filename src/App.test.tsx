// @vitest-environment jsdom
/**
 * The async wiring around the import scan. Both cases here are ordering races:
 * every module involved is correct on its own, and the defect only appears when
 * results arrive in an order the code did not expect.
 */
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanReport } from "./import/catalog";
import { MAX_SOURCE_ROOTS } from "./import/source-roots";

const bridge = vi.hoisted(() => ({
  scanRoots: vi.fn<(roots: Array<{ id: string; path: string }>) => Promise<ScanReport>>(),
  readDocument: vi.fn<(path: string) => Promise<string>>(),
  pickDocumentToOpen: vi.fn<() => Promise<string | null>>(),
  pickSourceRoot: vi.fn<() => Promise<string | null>>(),
  writeDocument: vi.fn(),
  exportBundle: vi.fn(),
  pickDocumentToSave: vi.fn(),
  pickExportDirectory: vi.fn(),
}));

vi.mock("./bridge/tauri", () => bridge);

const { App } = await import("./App");

/** A deferred promise, so a test controls exactly when async work lands. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function reportWith(names: Array<["skill" | "agent", string]>): ScanReport {
  return {
    artifacts: names.map(([kind, name]) => ({
      rootId: "personal:~/.claude",
      kind,
      name,
      path: `~/.claude/${kind}s/${name}`,
      contents: `---\nname: ${name}\ndescription: An artifact.\n---\n\nBody.\n`,
    })),
    problems: [],
  };
}

/** A saved document whose one Skill node is bound to `tdd`. */
const DOCUMENT = JSON.stringify({
  schemaVersion: 2,
  workflow: { name: "Bound", description: "A saved workflow." },
  nodes: [
    { id: "n1", type: "input", label: "In", data: { parameters: [{ name: "topic" }] } },
    { id: "n2", type: "skill", label: "TDD", data: { name: "tdd", rootId: "personal:~/.claude" } },
    { id: "n3", type: "output", label: "Out", data: { description: "the answer" } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
});

/** The same workflow, but its Skill node is set to vendor-copy `tdd`. */
const VENDOR_DOCUMENT = JSON.stringify({
  schemaVersion: 3,
  workflow: { name: "Bound", description: "A saved workflow." },
  nodes: [
    { id: "n1", type: "input", label: "In", data: { parameters: [{ name: "topic" }] } },
    {
      id: "n2",
      type: "skill",
      label: "TDD",
      data: { name: "tdd", rootId: "personal:~/.claude", exportMode: "vendor" },
    },
    { id: "n3", type: "output", label: "Out", data: { description: "the answer" } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
});

beforeEach(() => {
  // Deterministic root configuration: every test starts from the default root.
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
  // Re-stubbed per test because `afterEach` unstubs every global.
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.clearAllMocks();
  bridge.pickDocumentToOpen.mockResolvedValue("/tmp/bound.patchwork");
  bridge.readDocument.mockResolvedValue(DOCUMENT);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// React Flow measures its container; jsdom has no ResizeObserver.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const UNRESOLVED_NOTICE = /reference an artifact that is not in any configured source root/;

describe("opening a document while the initial scan is in flight", () => {
  it("given_scanLandsBeforeTheDocumentRead_whenLoaded_thenTheBindingIsNotFlaggedUnresolved", async () => {
    const scan = deferred<ScanReport>();
    const read = deferred<string>();
    bridge.scanRoots.mockReturnValue(scan.promise);
    bridge.readDocument.mockReturnValue(read.promise);

    render(<App />);
    fireEvent.click(screen.getByText("Load"));

    // The scan resolves first; the document arrives after.
    scan.resolve(reportWith([["skill", "tdd"]]));
    await waitFor(() => expect(screen.getByText(/Imported 1 skill/)).toBeTruthy());
    read.resolve(DOCUMENT);

    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    await waitFor(() =>
      expect(screen.queryByText(UNRESOLVED_NOTICE)).toBeNull(),
    );
  });

  it("given_scanLandsAfterTheDocumentRead_whenItArrives_thenTheBindingHeals", async () => {
    const scan = deferred<ScanReport>();
    bridge.scanRoots.mockReturnValue(scan.promise);

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    // Before the catalog lands, the binding cannot be resolved.
    expect(screen.getByText(UNRESOLVED_NOTICE)).toBeTruthy();

    scan.resolve(reportWith([["skill", "tdd"]]));

    await waitFor(() => expect(screen.queryByText(UNRESOLVED_NOTICE)).toBeNull());
  });
});

describe("a Skill/Agent node with nothing bound yet", () => {
  it("given_unboundRefNodesOnTheCanvas_whenAScanResolvesOverThem_thenNoUnresolvedNoticeIsShown", async () => {
    // These nodes reference nothing, so claiming they "reference an artifact that
    // is not in any configured source root" is a claim about a reference that does
    // not exist — and it contradicts the dock's own "No skill bound yet".
    //
    // The nodes are placed *before* a scan lands on them, because that is when
    // resolution re-runs: adding a root is the shortest reachable trigger.
    bridge.scanRoots.mockResolvedValue(reportWith([["skill", "tdd"]]));
    bridge.pickSourceRoot.mockResolvedValue("/work/app/.claude");

    render(<App />);
    await waitFor(() => expect(screen.getByText(/from 1 source root/)).toBeTruthy());
    fireEvent.click(screen.getByText("＋ Skill"));
    fireEvent.click(screen.getByText("＋ Agent"));
    fireEvent.click(screen.getByText("＋ Project root…"));

    await waitFor(() => expect(screen.getByText(/from 2 source root/)).toBeTruthy());
    expect(screen.queryByText(UNRESOLVED_NOTICE)).toBeNull();
  });
});

/** A document whose `workflow.description` is the wrong type. */
const HOSTILE_DOCUMENT = JSON.stringify({
  schemaVersion: 2,
  workflow: { name: "W", description: { evil: 1 } },
  nodes: [
    { id: "n1", type: "input", label: "In", data: { parameters: [{ name: "t" }] } },
    { id: "n2", type: "output", label: "Out", data: { description: "o" } },
  ],
  edges: [{ id: "e1", source: "n1", target: "n2" }],
});

describe("Export never fails into silence", () => {
  it("given_aDocumentWithAHostileDescription_whenLoaded_thenTheLoadIsRefusedWithAReason", async () => {
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.readDocument.mockResolvedValue(HOSTILE_DOCUMENT);

    render(<App />);
    fireEvent.click(screen.getByText("Load"));

    await waitFor(() =>
      expect(screen.getByText(/Load failed:.*must be a string when present/)).toBeTruthy(),
    );
  });

  it("given_exportWithAnInvalidGraph_whenClicked_thenTheStatusSaysSoAndNoPickerOpens", async () => {
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

    render(<App />);
    fireEvent.click(screen.getByText("Export"));

    // An empty canvas is invalid; the click must report, never no-op.
    await waitFor(() =>
      expect(screen.getByText(/Cannot export: fix validation errors first/)).toBeTruthy(),
    );
    expect(bridge.pickExportDirectory).not.toHaveBeenCalled();
  });
});

describe("Exporting a vendor-copy node", () => {
  it("given_aVendorModeNodeWhoseArtifactIsResolved_whenExported_thenItsBytesAreInTheBundle", async () => {
    bridge.scanRoots.mockResolvedValue(reportWith([["skill", "tdd"]]));
    bridge.readDocument.mockResolvedValue(VENDOR_DOCUMENT);
    bridge.pickExportDirectory.mockResolvedValue("/out");
    bridge.exportBundle.mockResolvedValue("/out/patchwork-bound");

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    fireEvent.click(screen.getByText("Export"));

    await waitFor(() => expect(bridge.exportBundle).toHaveBeenCalled());
    const [tree] = bridge.exportBundle.mock.calls[0] as [
      { files: Array<{ path: string; contents: string }> },
    ];
    // Copies first, marker and umbrella last: a half-written bundle must not be
    // discoverable (see `compile`).
    expect(tree.files.map((f) => f.path)).toEqual([
      "skills/tdd/SKILL.md",
      ".claude-plugin/plugin.json",
      "SKILL.md",
    ]);
    expect(tree.files[0].contents).toBe(
      "---\nname: tdd\ndescription: An artifact.\n---\n\nBody.\n",
    );
  });

  it("given_aVendorModeNodeWithNoResolvedArtifact_whenExported_thenItIsRefusedWithAReason", async () => {
    // Bytes that are not there cannot be copied, and a bundle missing the copy it
    // promises would fail later, inside Claude Code.
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.readDocument.mockResolvedValue(VENDOR_DOCUMENT);

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    fireEvent.click(screen.getByText("Export"));

    await waitFor(() =>
      expect(
        screen.getByText(
          /Skill node 'n2' is set to copy 'tdd' into the bundle, but that artifact is not in any configured source root/,
        ),
      ).toBeTruthy(),
    );
    expect(bridge.pickExportDirectory).not.toHaveBeenCalled();
    expect(bridge.exportBundle).not.toHaveBeenCalled();
  });
});

describe("Export is not re-entrant", () => {
  /**
   * `write_bundle` clears the destination and then writes the files one by one, so
   * two exports of the same workflow interleave: the second one's `remove_dir_all`
   * can land between the first one's writes, and the first would still report
   * success — for a bundle now missing a vendored dependency. The window is N files
   * wide since vendor-copy, so the renderer must not open it at all.
   */
  it("given_exportInFlight_whenTheButtonIsClickedAgain_thenOnlyOneExportRuns", async () => {
    const pick = deferred<string | null>();
    bridge.scanRoots.mockResolvedValue(reportWith([["skill", "tdd"]]));
    bridge.readDocument.mockResolvedValue(VENDOR_DOCUMENT);
    bridge.pickExportDirectory.mockReturnValue(pick.promise);
    bridge.exportBundle.mockResolvedValue("/out/patchwork-bound");

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());

    const button = screen.getByText("Export");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(bridge.pickExportDirectory).toHaveBeenCalledTimes(1));
    pick.resolve("/out");
    await waitFor(() => expect(screen.getByText(/Exported bundle to/)).toBeTruthy());
    expect(bridge.exportBundle).toHaveBeenCalledTimes(1);
  });

  it("given_exportInFlight_whenRendered_thenTheButtonSaysSoAndIsDisabled", async () => {
    const pick = deferred<string | null>();
    bridge.scanRoots.mockResolvedValue(reportWith([["skill", "tdd"]]));
    bridge.readDocument.mockResolvedValue(VENDOR_DOCUMENT);
    bridge.pickExportDirectory.mockReturnValue(pick.promise);
    bridge.exportBundle.mockResolvedValue("/out/patchwork-bound");

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    fireEvent.click(screen.getByText("Export"));

    const button = await waitFor(
      () => screen.getByText("Exporting…") as HTMLButtonElement,
    );
    expect(button.disabled).toBe(true);

    pick.resolve("/out");
    await waitFor(() => expect(screen.getByText("Export")).toBeTruthy());
  });

  it("given_anExportThatFailed_whenClickedAgain_thenTheButtonIsUsableAgain", async () => {
    bridge.scanRoots.mockResolvedValue(reportWith([["skill", "tdd"]]));
    bridge.readDocument.mockResolvedValue(VENDOR_DOCUMENT);
    bridge.pickExportDirectory.mockResolvedValue("/out");
    bridge.exportBundle.mockRejectedValueOnce(new Error("disk full"));

    render(<App />);
    fireEvent.click(screen.getByText("Load"));
    await waitFor(() => expect(screen.getByText(/Loaded/)).toBeTruthy());
    fireEvent.click(screen.getByText("Export"));
    await waitFor(() => expect(screen.getByText(/Export failed:.*disk full/)).toBeTruthy());

    // A failed export must not leave the button dead — the guard has to be
    // released on every path out, not just the happy one.
    bridge.exportBundle.mockResolvedValue("/out/patchwork-bound");
    fireEvent.click(screen.getByText("Export"));

    await waitFor(() => expect(screen.getByText(/Exported bundle to/)).toBeTruthy());
    expect(bridge.exportBundle).toHaveBeenCalledTimes(2);
  });
});

describe("persisted root configuration", () => {
  /**
   * `src/main.tsx` renders inside StrictMode, which double-invokes mount effects
   * in development. A guard that counts invocations survives that and writes on
   * the second pass, so the data-preservation guarantee has to be asserted with
   * StrictMode in place — a plain `render` cannot see this class of defect.
   */
  it.each([
    ["20 roots, four beyond the cap", JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        id: `project:/work/${i}`,
        path: `/work/${i}`,
        role: "project",
      })),
    )],
    ["an unparseable value", "{not json"],
    ["a value with stale ids", JSON.stringify([
      { id: "stale", path: "/work/.claude", role: "project" },
    ])],
  ])(
    "given_%s_whenMountedUnderStrictMode_thenStorageIsNotOverwritten",
    async (_case, stored) => {
      const writes: string[] = [];
      vi.stubGlobal("localStorage", {
        getItem: () => stored,
        setItem: (_k: string, v: string) => writes.push(v),
        removeItem: () => {},
      });
      bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

      render(
        <StrictMode>
          <App />
        </StrictMode>,
      );
      await waitFor(() => expect(bridge.scanRoots).toHaveBeenCalled());

      expect(writes).toEqual([]);
    },
  );

  it("given_aRealChangeUnderStrictMode_whenMade_thenItIsPersistedExactlyOnce", async () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (_k: string, v: string) => writes.push(v),
      removeItem: () => {},
    });
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    fireEvent.click(screen.getByLabelText("Remove source root ~/.claude"));

    await waitFor(() => expect(writes).toEqual(["[]"]));
  });

  it("given_aStoredConfigurationBeyondTheCap_whenMounted_thenStorageIsNotOverwritten", async () => {
    const stored = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        id: `project:/work/${i}`,
        path: `/work/${i}`,
        role: "project",
      })),
    );
    const writes: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => stored,
      setItem: (_k: string, v: string) => writes.push(v),
      removeItem: () => {},
    });
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

    render(<App />);
    await waitFor(() => expect(bridge.scanRoots).toHaveBeenCalled());

    // Mount salvaged 16 of 20 roots; it must not write that back and destroy
    // the four it could not restore.
    expect(writes).toEqual([]);
  });

  it("given_anUnparseableStoredValue_whenMounted_thenItIsLeftForRepair", async () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => "{not json",
      setItem: (_k: string, v: string) => writes.push(v),
      removeItem: () => {},
    });
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

    render(<App />);
    await waitFor(() => expect(bridge.scanRoots).toHaveBeenCalled());

    expect(writes).toEqual([]);
  });

  it("given_aRealChange_whenMade_thenItIsPersisted", async () => {
    const writes: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (_k: string, v: string) => writes.push(v),
      removeItem: () => {},
    });
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });

    render(<App />);
    fireEvent.click(screen.getByLabelText("Remove source root ~/.claude"));

    await waitFor(() => expect(writes).toEqual(["[]"]));
  });
});

describe("changing the roots while the add-root picker is open", () => {
  it("given_aRootPickedThatIsAlreadyConfigured_whenItResolves_thenTheUserIsTold", async () => {
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.pickSourceRoot.mockResolvedValue("~/.claude");

    render(<App />);
    // Let the start-up scan settle first, so its status line is not what we read.
    await waitFor(() => expect(screen.getByText(/Imported 0 skill/)).toBeTruthy());
    fireEvent.click(screen.getByText("＋ Personal root…"));

    await waitFor(() =>
      expect(document.querySelector(".pw-status")?.textContent).toMatch(
        /already a configured personal source root/,
      ),
    );
    // A no-op add must not trigger another scan either.
    expect(bridge.scanRoots).toHaveBeenCalledTimes(1);
  });

  it("given_aRootPickedWhenTheConfigurationIsFull_whenItResolves_thenTheRefusalIsReportedNotSuccess", async () => {
    // The refusal used to be reported as `Added project source root '…'` — and
    // because a refused add is identity-stable, no rescan followed to overwrite
    // it, so the false message was the one that stayed on screen.
    const full = JSON.stringify(
      Array.from({ length: MAX_SOURCE_ROOTS }, (_unused, i) => ({
        id: `project:/work/${i}/.claude`,
        path: `/work/${i}/.claude`,
        role: "project",
      })),
    );
    vi.stubGlobal("localStorage", {
      getItem: () => full,
      setItem: () => {},
      removeItem: () => {},
    });
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.pickSourceRoot.mockResolvedValue("/work/extra/.claude");

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Imported 0 skill/)).toBeTruthy());
    fireEvent.click(screen.getByText("＋ Project root…"));

    await waitFor(() =>
      expect(document.querySelector(".pw-status")?.textContent).toMatch(
        new RegExp(`at the limit of ${MAX_SOURCE_ROOTS} source roots`),
      ),
    );
    expect(document.querySelector(".pw-status")?.textContent).not.toMatch(/^Added /);
    expect(bridge.scanRoots).toHaveBeenCalledTimes(1);
  });

  it("given_aRootPickedThatIsNew_whenItResolves_thenTheSuccessSaysAScanIsComing", async () => {
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.pickSourceRoot.mockResolvedValue("/work/app/.claude");

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Imported 0 skill/)).toBeTruthy());
    fireEvent.click(screen.getByText("＋ Project root…"));

    // The rescan replaces this line within milliseconds, so it has to read as
    // handing off rather than as a confirmation that got cut off.
    await waitFor(() =>
      expect(document.querySelector(".pw-status")?.textContent).toMatch(
        /Added project source root '\/work\/app\/\.claude' — scanning…/,
      ),
    );
    await waitFor(() => expect(bridge.scanRoots).toHaveBeenCalledTimes(2));
  });

  it("given_aRootRemovedWhileThePickerIsPending_whenItResolves_thenTheRemovalIsNotUndone", () => {
    const picker = deferred<string | null>();
    bridge.scanRoots.mockResolvedValue({ artifacts: [], problems: [] });
    bridge.pickSourceRoot.mockReturnValue(picker.promise);
    const persisted: string[] = [];
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (_key: string, value: string) => persisted.push(value),
      removeItem: () => {},
    });

    render(<App />);
    fireEvent.click(screen.getByText("＋ Project root…"));
    fireEvent.click(screen.getByLabelText("Remove source root ~/.claude"));
    picker.resolve("/work/app/.claude");

    return waitFor(() => {
      expect(screen.queryByText("~/.claude")).toBeNull();
      expect(screen.getByText("/work/app/.claude")).toBeTruthy();
      // The resurrection also used to be persisted, so it survived a restart.
      expect(persisted.at(-1)).not.toContain("~/.claude");
    });
  });
});

describe("an obsolete in-flight scan", () => {
  it("given_rootsChangeWhileASlowScanRuns_whenItCompletes_thenItDoesNotClobberTheNewerResult", async () => {
    const slow = deferred<ScanReport>();
    const fast = deferred<ScanReport>();
    bridge.scanRoots
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(fast.promise);

    render(<App />);
    // Remove the only root while the first scan is still running.
    fireEvent.click(screen.getByLabelText("Remove source root ~/.claude"));
    await waitFor(() => expect(bridge.scanRoots).toHaveBeenCalledTimes(2));

    fast.resolve({ artifacts: [], problems: [] });
    await waitFor(() =>
      expect(screen.getByText(/from 0 source root\(s\)/)).toBeTruthy(),
    );
    // The superseded scan lands late with artifacts from the removed root.
    slow.resolve(reportWith([["skill", "tdd"]]));

    await waitFor(() =>
      expect(screen.getByText(/Imported 0 skill\(s\) and 0 agent\(s\)/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Imported 1 skill/)).toBeNull();
  });
});
