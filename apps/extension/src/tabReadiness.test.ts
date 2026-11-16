import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForTabReady } from "./tabReadiness";

function harness() {
  const updates: ((id: number) => void)[] = [];
  const removals: ((id: number) => void)[] = [];
  const get = vi.fn().mockResolvedValue({ id: 42, status: "loading" });
  const removeUpdated = vi.fn();
  const removeRemoved = vi.fn();
  vi.stubGlobal("chrome", { tabs: {
    get,
    onUpdated: { addListener: (listener: (id: number) => void) => updates.push(listener), removeListener: removeUpdated },
    onRemoved: { addListener: (listener: (id: number) => void) => removals.push(listener), removeListener: removeRemoved },
  } });
  return { get, updates, removals, removeUpdated, removeRemoved };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("tab readiness", () => {
  it("does not return the old page while navigation is pending", async () => {
    const h = harness();
    h.get.mockResolvedValue({ id: 42, status: "complete", pendingUrl: "https://example.com/new" });
    const resolved = vi.fn();
    const promise = waitForTabReady(42).then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    h.get.mockResolvedValue({ id: 42, status: "complete", url: "https://example.com/new" });
    h.updates[0]!(42);
    await promise;
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/new" }));
    expect(h.removeUpdated).toHaveBeenCalledOnce();
    expect(h.removeRemoved).toHaveBeenCalledOnce();
  });

  it("surfaces a bounded timeout with an inspect-before-retry warning", async () => {
    vi.useFakeTimers();
    const h = harness();
    const promise = waitForTabReady(42);
    const expected = expect(promise).rejects.toThrow("do not repeat a submission");
    await vi.advanceTimersByTimeAsync(15000);
    await expected;
    expect(h.removeUpdated).toHaveBeenCalledOnce();
  });

  it("rejects promptly if the tab closes and ignores updates from other tabs", async () => {
    const h = harness();
    const promise = waitForTabReady(42);
    h.updates[0]!(99);
    expect(h.get).toHaveBeenCalledOnce();
    h.removals[0]!(42);
    await expect(promise).rejects.toThrow("was closed");
  });
});
