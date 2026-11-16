import { afterEach, describe, expect, it, vi } from "vitest";
import { companionFetch, NATIVE_HOST } from "./companion";

const healthy = () => Response.json({ ok: true, service: "chrome-gpt-live" });
const refused = () => Promise.reject(new TypeError("Failed to fetch"));

afterEach(() => vi.unstubAllGlobals());

function stub(fetchImpl: (url: string) => Promise<Response>, sendNativeMessage = vi.fn()) {
  const fetchMock = vi.fn((url: string) => fetchImpl(url));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", { runtime: { sendNativeMessage } });
  return { fetchMock, sendNativeMessage };
}

describe("companionFetch", () => {
  it("talks to a running companion without starting it", async () => {
    const { sendNativeMessage } = stub(async () => Response.json({ done: true }));
    expect(await (await companionFetch("/api/configuration", { method: "POST" }, 1000)).json()).toEqual({ done: true });
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });

  it("starts a stopped companion through the native host and retries once", async () => {
    let started = false;
    const { fetchMock, sendNativeMessage } = stub(
      async (url) => (started ? (url.endsWith("/health") ? healthy() : Response.json({ done: true })) : refused()),
      vi.fn(async () => {
        started = true;
        return { ok: true, status: "started" };
      }),
    );
    const response = await companionFetch("/api/live/session", { method: "POST", body: "{}" }, 1000);
    expect(await response.json()).toEqual({ done: true });
    expect(sendNativeMessage).toHaveBeenCalledWith(NATIVE_HOST, { type: "start" });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/live/session"))).toHaveLength(2);
  });

  it("does not replay a request when the companion was already healthy", async () => {
    const { fetchMock, sendNativeMessage } = stub(async (url) => (url.endsWith("/health") ? healthy() : refused()));
    await expect(companionFetch("/api/controller/round", { method: "POST" })).rejects.toThrow("Failed to fetch");
    expect(sendNativeMessage).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/api/controller/round"))).toHaveLength(1);
  });

  it("explains how to enable automatic start when the native host is missing", async () => {
    stub(refused, vi.fn().mockRejectedValue(new Error("Specified native messaging host not found.")));
    await expect(companionFetch("/api/configuration")).rejects.toThrow(/npm run setup.*native messaging host not found/s);
  });

  it("reports native host start failures", async () => {
    stub(refused, vi.fn().mockResolvedValue({ ok: false, error: "The companion exited (1). See companion.log." }));
    await expect(companionFetch("/api/configuration")).rejects.toThrow("could not start: The companion exited (1)");
  });
});
