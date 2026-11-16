// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityCard } from "./ActivityCard";

let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("live activity feedback", () => {
  it("shows elapsed time immediately and adds slow feedback at exactly eight seconds", async () => {
    await act(async () => root.render(<ActivityCard activity={{ phase: "thinking", label: "Astra is working", since: Date.now() }} />));
    expect(document.body.textContent).toContain("0s");
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(document.body.textContent).toContain("7s");
    expect(document.body.textContent).not.toContain("still working");
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(document.body.textContent).toContain("8s");
    expect(document.body.textContent).toContain("still working");
  });

  it("shows confirmation instructions without pretending work is progressing", async () => {
    await act(async () => root.render(<ActivityCard activity={{ phase: "confirming", label: "Waiting for approval", since: Date.now() }} />));
    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(document.body.textContent).toContain("Confirm or Decline");
    expect(document.body.textContent).not.toContain("15s");
    expect(document.body.textContent).not.toContain("still working");
  });
});
