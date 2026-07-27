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
