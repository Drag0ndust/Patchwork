// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): never {
  throw new Error("boom in child");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("given_childThrows_whenRendered_thenShowsFallbackInsteadOfBlankUi", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const fallback = screen.getByRole("alert");
    expect(fallback.textContent).toContain("Something went wrong");
    expect(fallback.textContent).toContain("boom in child");
  });

  it("given_healthyChild_whenRendered_thenShowsChild", () => {
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("healthy content")).toBeDefined();
  });
});
