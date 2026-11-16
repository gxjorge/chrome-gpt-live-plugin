// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastCommand, FastScope, FastSnapshot } from "@chrome-gpt-live/shared";
import { createFastBrowser } from "./fastBrowser";

let scope: FastScope;
const rect = { top: 10, left: 10, right: 110, bottom: 40, width: 100, height: 30, x: 10, y: 10, toJSON() {} };
let hit: Element | null;
beforeEach(() => {
  scope = { sessionId: "session-1", runId: "run-1", revision: 1, tabId: 42, expiresAtMs: Date.now() + 60000 };
  document.body.innerHTML = '<button aria-expanded="false">Menu</button><input type="password" value="never-expose"><textarea>private-field-text</textarea>';
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  vi.stubGlobal("scrollX", 0); vi.stubGlobal("scrollY", 0);
  vi.stubGlobal("scrollBy", vi.fn());
  hit = document.querySelector("button");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
  // Match real Chrome URL validation rather than jsdom's default about:blank.
  vi.stubGlobal("location", new URL("https://example.com/"));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function harness() {
  const browser = createFastBrowser({ label: (element) => element.textContent || "field",
    check: (element) => /checkout/i.test(element.textContent ?? "") ? { ok: false, summary: "payment blocked" } : undefined });
  browser.bind(scope);
  return browser;
}
function command(snapshot: FastSnapshot, patch: Partial<FastCommand> = {}): FastCommand {
  return { scope, documentId: snapshot.documentId, snapshotId: snapshot.snapshotId, stepId: "step-1", operation: "CLICK", targetId: "t1", ...patch };
}

describe("grounded fast browser execution", () => {
  it("exports compact observed handles without input values or editable text", () => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    expect(snapshot.targets).toHaveLength(1);
    expect(snapshot.targets[0]).toMatchObject({ id: "t1", label: "Menu" });
    expect(JSON.stringify(snapshot)).not.toMatch(/never-expose|private-field-text/);
  });
  it("executes a connected, uncovered node and never replays its step ID", async () => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    const element = document.querySelector("button")!;
    const click = vi.spyOn(element, "click").mockImplementation(() => element.setAttribute("aria-expanded", "true"));
    expect(await browser.execute(command(snapshot))).toMatchObject({ ok: true, outcome: "executed" });
    expect(await browser.execute(command(snapshot))).toMatchObject({ ok: false, outcome: "rejected" });
    expect(click).toHaveBeenCalledOnce();
    expect(browser.wasAttempted(scope.runId, element)).toBe(true);
    browser.cancel(scope);
    expect(browser.wasAttempted(scope.runId, element)).toBe(true);
  });
  it("rejects a replacement node even when its label and geometry are identical", async () => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    document.querySelector("button")!.outerHTML = '<button aria-expanded="false">Menu</button>';
    hit = document.querySelector("button");
    const click = vi.spyOn(hit as HTMLButtonElement, "click");
    expect(await browser.execute(command(snapshot))).toMatchObject({ outcome: "rejected" });
    expect(click).not.toHaveBeenCalled();
  });
  it.each(["label", "state", "occlusion", "viewport", "disabled"])("rejects changed %s before input", async (change) => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    const element = document.querySelector("button")!;
    const click = vi.spyOn(element, "click");
    if (change === "label") element.textContent = "Different";
    if (change === "state") element.setAttribute("aria-expanded", "true");
    if (change === "occlusion") hit = document.body;
    if (change === "viewport") vi.stubGlobal("scrollY", 50);
    if (change === "disabled") element.disabled = true;
    expect(await browser.execute(command(snapshot))).toMatchObject({ ok: false, outcome: "rejected" });
    expect(click).not.toHaveBeenCalled();
  });
  it("rejects old snapshots and cancelled/superseded scopes", async () => {
    const browser = harness();
    const first = browser.snapshot(scope);
    browser.snapshot(scope);
    expect(await browser.execute(command(first))).toMatchObject({ outcome: "rejected" });
    const current = browser.snapshot(scope);
    browser.cancel(scope);
    expect(await browser.execute(command(current))).toMatchObject({ outcome: "rejected" });
    browser.bind({ ...scope, runId: "other" });
    expect(() => browser.snapshot(scope)).toThrow("no longer bound");
  });
  it("excludes controls hidden by an opaque ancestor", () => {
    document.body.innerHTML = '<div style="opacity:0"><button>Hidden</button></div>';
    expect(harness().snapshot(scope).targets).toEqual([]);
  });
  it("excludes policy-blocked, destructive, native-select and submit targets", () => {
    document.body.innerHTML = '<button>Checkout</button><button>Delete account</button><form><button>Save</button></form><select><option>One</option></select>';
    expect(harness().snapshot(scope).targets).toEqual([]);
  });
  it("does not invalidate a target merely because an unrelated animation changed", async () => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    const unrelated = document.createElement("aside");
    unrelated.textContent = "Animated counter";
    document.body.append(unrelated);
    const element = document.querySelector("button")!;
    vi.spyOn(element, "click").mockImplementation(() => element.setAttribute("aria-expanded", "true"));
    // The counter is not inside the target's local context.
    element.parentElement!.removeChild(unrelated);
    document.head.append(unrelated);
    expect(await browser.execute(command(snapshot))).toMatchObject({ ok: true });
  });
  it("marks input exceptions uncertain instead of enabling a retry", async () => {
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    const element = document.querySelector("button")!;
    vi.spyOn(element, "click").mockImplementation(() => { throw new Error("port closed after input"); });
    expect(await browser.execute(command(snapshot))).toMatchObject({ ok: false, outcome: "uncertain" });
    expect(await browser.execute(command(snapshot))).toMatchObject({ outcome: "rejected" });
    browser.cancel(scope);
    expect(browser.wasAttempted(scope.runId, element)).toBe(true);
    expect(browser.wasAttempted("new-run", element)).toBe(false);
  });
  it("rejects queued input at the exact wall-clock deadline even before a cancel message arrives", async () => {
    vi.useFakeTimers();
    const browser = harness();
    const snapshot = browser.snapshot(scope);
    const click = vi.spyOn(document.querySelector("button")!, "click");
    vi.setSystemTime(scope.expiresAtMs);
    expect(await browser.execute(command(snapshot))).toMatchObject({ outcome: "rejected" });
    expect(click).not.toHaveBeenCalled();
    expect(() => browser.snapshot(scope)).toThrow("expired");
  });
  it("enforces eight attempted actions, including waits", async () => {
    vi.useFakeTimers();
    const browser = harness();
    for (let index = 0; index < 8; index++) {
      const result = browser.execute(command(browser.snapshot(scope), { operation: "WAIT", stepId: `step-${index}` }));
      await vi.advanceTimersByTimeAsync(150);
      expect(await result).toMatchObject({ ok: true });
    }
    expect(await browser.execute(command(browser.snapshot(scope), { operation: "WAIT", stepId: "step-9" }))).toMatchObject({ outcome: "rejected", summary: expect.stringContaining("budget") });
  });
});
