import type { FoundryConfiguration, PageContext } from "@chrome-gpt-live/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveSession } from "./liveSession";

const captureMicrophone = vi.hoisted(() => vi.fn());
vi.mock("../microphone", () => ({ captureMicrophone }));

class TestChannel extends EventTarget {
  readyState = "open";
  send = vi.fn<(data: string) => void>();
  close() {
    this.readyState = "closed";
  }
}

const page: PageContext = {
  url: "https://example.com/article", title: "Article", description: "", byline: "",
  excerpt: "", headings: [], links: [], citations: [], capturedAt: "2026-09-23T00:00:00Z",
};

async function harness(initialPage: PageContext | null = page, configuration?: FoundryConfiguration) {
  const channel = new TestChannel();
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] };
  captureMicrophone.mockResolvedValue(stream);
  vi.stubGlobal("Audio", class {
    autoplay = false;
    srcObject = null;
  });
  vi.stubGlobal("RTCPeerConnection", class extends EventTarget {
    addTrack() {}
    addTransceiver() {}
    createDataChannel() { return channel; }
    async createOffer() { return { sdp: "test-offer" }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    sessionId: "test-session", sdp: "test-answer", ...(configuration?.browserControl === "md1-first" ? { controllerMode: "md1-first" } : {}),
  })));
  const sendMessage = vi.fn().mockResolvedValue({ ok: true, summary: "Done" });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  const callbacks = {
    onStatus: vi.fn(), onTranscript: vi.fn(), onAction: vi.fn(), onError: vi.fn(), onTabChanged: vi.fn(),
    onActivity: vi.fn(), onActionStart: vi.fn(), onControllerText: vi.fn(), onPageChanged: vi.fn(),
    onConfirmation: vi.fn<ConstructorParameters<typeof LiveSession>[0]["onConfirmation"]>(),
  };
  const session = new LiveSession(callbacks);
  await session.start(42, initialPage ?? undefined, configuration);
  const receive = (event: object) => channel.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "response.event", delegation_id: "delegation-1", event }),
  }));
  const calls = (items: { call_id: string; name: string; arguments: string }[]) => {
    receive({ type: "response.created", response: { id: "response-1" } });
    for (const item of items) {
      receive({ type: "response.output_item.done", item: { type: "function_call", ...item } });
    }
    receive({ type: "response.completed", response: { id: "response-1" } });
  };
  return { session, channel, sendMessage, callbacks, calls, receive, stopTrack };
}

describe("LiveSession tool results", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("honors negotiated client mode and task Stop without stopping microphone capture", async () => {
    const h = await harness(page, { browserControl: "md1-first" });
    h.session.stopTask();
    expect(h.stopTrack).not.toHaveBeenCalled();
    expect(h.callbacks.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ label: expect.stringContaining("Voice conversation remains connected") }));
    const appended = h.channel.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(appended.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: null });
    await h.session.stop();
    expect(h.stopTrack).toHaveBeenCalledOnce();
  });

  it("connects from a blank tab without fabricating page data and later adopts the navigated website", async () => {
    const h = await harness(null);
    const request = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
    expect(request).toEqual({ sdp: "test-offer" });
    h.channel.dispatchEvent(new Event("open"));
    expect(JSON.parse(h.channel.send.mock.calls[0]![0])).toMatchObject({
      type: "session.thinking.append", content: expect.stringContaining("No website is open"),
    });
    h.sendMessage.mockResolvedValue({ ok: true, summary: "Opened website", data: { tabId: 42, page } });
    h.calls([{ call_id: "call-1", name: "navigate", arguments: '{"url":"https://example.com/article"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onPageChanged).toHaveBeenCalledWith(page));
    await h.session.stop();
  });

  it("uses the same configuration snapshot for voice and visual inspection", async () => {
    const configuration = {
      projectEndpoint: "https://example.services.ai.azure.com/api/projects/example-project",
      liveDeployment: "saved-live", astraDeployment: "saved-controller",
    };
    const h = await harness(page, configuration);
    const original = { ...configuration };
    configuration.astraDeployment = "changed-after-start";
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string).configuration).toEqual(original);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ analysis: "Synthetic visual result." }));
    h.sendMessage.mockResolvedValueOnce({ ok: true, page })
      .mockResolvedValueOnce({ ok: true, screenshot: "data:image/png;base64,AA==" });
    h.calls([{ call_id: "inspect-1", name: "inspect_viewport", arguments: '{"question":"What is visible?"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onAction).toHaveBeenCalledOnce());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string).configuration).toEqual(original);
    expect(h.callbacks.onAction.mock.calls[0]?.[1]).toMatchObject({ ok: true, data: { analysis: "Synthetic visual result." } });
    await h.session.stop();
  });

  it("clears old article context when navigating back to an empty tab", async () => {
    const h = await harness();
    h.sendMessage.mockResolvedValue({ ok: true, summary: "Went back", data: { tabId: 42, page: null } });
    h.calls([{ call_id: "call-1", name: "go_back", arguments: "{}" }]);
    await vi.waitFor(() => expect(h.callbacks.onPageChanged).toHaveBeenCalledWith(undefined));
    expect(h.channel.send.mock.calls.some(([raw]) => JSON.parse(raw).type === "session.thinking.append")).toBe(false);
    await h.session.stop();
  });

  it("ignores delayed connection and transcript events after deactivation", async () => {
    const h = await harness();
    await h.session.stop();
    h.callbacks.onActivity.mockClear();
    h.callbacks.onControllerText.mockClear();
    h.channel.dispatchEvent(new Event("open"));
    h.channel.dispatchEvent(new Event("close"));
    h.channel.dispatchEvent(new Event("error"));
    h.receive({ type: "response.output_text.delta", item_id: "late-message", delta: "Stale text" });
    expect(h.callbacks.onActivity).not.toHaveBeenCalled();
    expect(h.callbacks.onControllerText).not.toHaveBeenCalled();
    expect(h.callbacks.onError).not.toHaveBeenCalled();
  });

  it("preserves the first service error and stops microphone capture rather than leaving a dead conversation Live", async () => {
    const h = await harness();
    h.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "error", error: { code: "invalid_request_error", message: "The first request failed." },
    }) }));
    h.channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "error", error: { message: "Submit the pending function call outputs before response.create." },
    }) }));
    await Promise.resolve();
    expect(h.stopTrack).toHaveBeenCalledOnce();
    expect(h.callbacks.onStatus).toHaveBeenLastCalledWith("Disconnected");
    expect(h.callbacks.onError).toHaveBeenCalledOnce();
    expect(h.callbacks.onError).toHaveBeenCalledWith(expect.stringContaining("The first request failed."));
    expect(h.session.exportDiagnostics()).toContain("invalid_request_error");
  });

  it("bounds appended context below the token budget even for non-English content", async () => {
    const h = await harness({ ...page, title: "\u6f22".repeat(1000) });
    h.channel.dispatchEvent(new Event("open"));
    const context = JSON.parse(h.channel.send.mock.calls[0]![0]);
    expect(new TextEncoder().encode(context.content).byteLength).toBeLessThanOrEqual(480);
    await h.session.stop();
  });

  it("streams visible Astra text and thinking phases before any browser action completes", async () => {
    const h = await harness();
    h.receive({ type: "response.created", response: { id: "response-1" } });
    expect(h.callbacks.onActivity).toHaveBeenLastCalledWith({ phase: "thinking", label: "Astra is working on your request" });
    h.receive({ type: "response.output_text.delta", item_id: "message-1", delta: "First useful answer" });
    expect(h.callbacks.onControllerText).toHaveBeenLastCalledWith("message-1", "First useful answer", false);
    h.receive({ type: "response.reasoning_summary_text.delta", item_id: "private", delta: "Not user-facing text" });
    expect(h.callbacks.onControllerText).toHaveBeenCalledOnce();
    h.receive({ type: "response.output_text.done", item_id: "message-1", text: "First useful answer." });
    expect(h.callbacks.onControllerText).toHaveBeenLastCalledWith("message-1", "First useful answer.", true);
    h.receive({ type: "response.completed", response: { id: "response-1" } });
    expect(h.callbacks.onActivity).toHaveBeenLastCalledWith({ phase: "idle", label: "Answer ready. Keep the conversation going." });
    await h.session.stop();
  });

  it("shows actions while they are running and updates the current page from navigation results", async () => {
    const h = await harness();
    let finish!: (value: unknown) => void;
    h.sendMessage.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    h.calls([{ call_id: "call-1", name: "navigate", arguments: '{"url":"https://example.com/new"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onActionStart).toHaveBeenCalledOnce());
    expect(h.callbacks.onAction).not.toHaveBeenCalled();
    expect(h.callbacks.onActivity).toHaveBeenLastCalledWith({ phase: "acting", label: "Opening example.com" });
    const newPage = { ...page, url: "https://example.com/new", title: "New page" };
    finish({ ok: true, summary: "Loaded", data: { tabId: 42, page: newPage } });
    await vi.waitFor(() => expect(h.callbacks.onAction).toHaveBeenCalledOnce());
    expect(h.callbacks.onPageChanged).toHaveBeenCalledWith(newPage);
    await h.session.stop();
  });

  it("reports bounded tool timeouts and suppresses late page updates", async () => {
    vi.useFakeTimers();
    const h = await harness();
    let finish!: (value: unknown) => void;
    h.sendMessage.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    h.calls([{ call_id: "call-1", name: "get_page_context", arguments: "{}" }]);
    await vi.advanceTimersByTimeAsync(20000);
    expect(h.callbacks.onAction).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ ok: false, summary: expect.stringContaining("timed out") }),
      "call-1", expect.any(Number),
    );
    finish({ ok: true, summary: "Too late", data: page });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.callbacks.onPageChanged).not.toHaveBeenCalled();
    await h.session.stop();
    vi.useRealTimers();
  });

  it("holds continuation until every confirmation is resolved and ignores duplicate approval clicks", async () => {
    const h = await harness();
    h.sendMessage.mockResolvedValue({ ok: false, requiresConfirmation: true, summary: "Confirm publish" });
    h.calls([
      { call_id: "call-1", name: "click", arguments: '{"text":"Publish"}' },
      { call_id: "call-2", name: "click", arguments: '{"text":"Send"}' },
    ]);
    await vi.waitFor(() => expect(h.callbacks.onConfirmation).toHaveBeenCalledOnce());
    expect(h.channel.send).not.toHaveBeenCalled();

    const decline = h.callbacks.onConfirmation.mock.calls[0]![2];
    await decline(false);
    await decline(false);
    await vi.waitFor(() => expect(h.callbacks.onConfirmation).toHaveBeenCalledTimes(2));
    expect(h.channel.send).not.toHaveBeenCalled();

    h.sendMessage.mockResolvedValue({ ok: true, summary: "Sent" });
    const approve = h.callbacks.onConfirmation.mock.calls[1]![2];
    await approve(true);
    await approve(true);
    await vi.waitFor(() => expect(h.channel.send).toHaveBeenCalledTimes(3));
    expect(h.sendMessage).toHaveBeenCalledTimes(3);
    expect(h.sendMessage.mock.calls[2]?.[0]).toMatchObject({ confirmed: true });
    expect(h.channel.send.mock.calls.map(([raw]) => JSON.parse(raw))).toMatchObject([
      { type: "response.item.create", item: { call_id: "call-1", output: JSON.stringify({ ok: false, summary: "The user declined the irreversible action." }) } },
      { type: "response.item.create", item: { call_id: "call-2", output: JSON.stringify({ ok: true, summary: "Sent" }) } },
      { type: "response.create" },
    ]);
    await h.session.stop();
  });

  it("submits failure outputs for malformed arguments and browser messaging errors", async () => {
    const h = await harness();
    h.sendMessage.mockRejectedValue(new Error("Tab no longer exists"));
    h.calls([
      { call_id: "call-1", name: "click", arguments: "not-json" },
      { call_id: "call-2", name: "get_page_context", arguments: "{}" },
    ]);
    await vi.waitFor(() => expect(h.channel.send).toHaveBeenCalledTimes(3));
    const messages = h.channel.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(JSON.parse(messages[0].item.output)).toMatchObject({ ok: false });
    expect(JSON.parse(messages[1].item.output)).toEqual({
      ok: false, summary: "Could not execute get_page_context: Tab no longer exists",
    });
    expect(h.callbacks.onAction).toHaveBeenCalledWith(
      { name: "get_page_context", arguments: {} },
      expect.objectContaining({ ok: false }),
      "call-2",
      expect.any(Number),
    );
    await h.session.stop();
  });

  it("clicks the fast decision model's confident choice and adopts the page it navigates to", async () => {
    const h = await harness();
    const next = { ...page, url: "https://example.com/pricing", title: "Pricing" };
    const targets = [
      { id: "t0", selector: "[data-chrome-gpt-live-target=\"t0\"]", kind: "link", label: "Docs", href: "https://example.com/docs", navigates: true },
      { id: "t1", selector: "[data-chrome-gpt-live-target=\"t1\"]", kind: "link", label: "Pricing", href: "https://example.com/pricing", navigates: true },
    ];
    h.sendMessage.mockImplementation(async (message: { type: string }) => {
      switch (message.type) {
        case "LIST_CLICK_TARGETS": return { ok: true, targets, page: { title: page.title, url: page.url } };
        case "EXECUTE_ACTION": return { ok: true, summary: "Clicked Pricing." };
        case "AWAIT_NAVIGATION": return { ok: true, summary: "Opened the clicked link.", navigated: true, data: { tabId: 42, page: next } };
      }
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      target: "t1", confidence: 0.97, confident: true, ranked: [{ id: "t1", probability: 0.97 }],
    }));
    h.calls([{ call_id: "fast-1", name: "find_and_click", arguments: '{"goal":"open pricing"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onAction).toHaveBeenCalledOnce());
    const [url, request] = vi.mocked(fetch).mock.calls[1]!;
    expect(url).toMatch(/\/api\/decision\/click-target$/);
    const body = JSON.parse(request!.body as string);
    expect(body).toMatchObject({ goal: "open pricing", page: { url: page.url } });
    expect(body.targets[1]).toEqual({ id: "t1", kind: "link", label: "Pricing", href: "https://example.com/pricing" });
    expect(h.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "EXECUTE_ACTION", action: { name: "click", arguments: { selector: targets[1]!.selector } }, confirmed: false,
    }));
    expect(h.callbacks.onAction.mock.calls[0]?.[1]).toMatchObject({
      ok: true, summary: expect.stringContaining('MD-1 chose "Pricing" (97%)'), data: { decidedBy: { confidence: 0.97, target: { label: "Pricing" } }, page: next },
    });
    expect(h.callbacks.onPageChanged).toHaveBeenCalledWith(next);
    await h.session.stop();
  });

  it("falls back to Astra with ranked candidates when the fast decision model is unsure", async () => {
    const h = await harness();
    const targets = [
      { id: "t0", selector: "#a", kind: "button", label: "Save", navigates: false },
      { id: "t1", selector: "#b", kind: "button", label: "Save as", navigates: false },
    ];
    h.sendMessage.mockImplementation(async (message: { type: string }) =>
      message.type === "LIST_CLICK_TARGETS" ? { ok: true, targets, page: { title: page.title, url: page.url } } : { ok: true, summary: "Done" });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      target: "t0", confidence: 0.52, confident: false, ranked: [{ id: "t0", probability: 0.52 }, { id: "t1", probability: 0.46 }],
    }));
    h.calls([{ call_id: "fast-1", name: "find_and_click", arguments: '{"goal":"save"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onAction).toHaveBeenCalledOnce());
    expect(h.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "EXECUTE_ACTION" }));
    expect(h.callbacks.onAction.mock.calls[0]?.[1]).toMatchObject({
      ok: false,
      summary: expect.stringContaining("not confident"),
      data: { candidates: [{ selector: "#a", label: "Save", probability: 0.52 }, { selector: "#b", label: "Save as", probability: 0.46 }] },
    });
    await h.session.stop();
  });

  it("keeps the confirmation gate for fast clicks without asking the decision model twice", async () => {
    const h = await harness();
    const targets = [{ id: "t0", selector: "#publish", kind: "button", label: "Publish", navigates: false }];
    let confirmedClick = false;
    h.sendMessage.mockImplementation(async (message: { type: string; confirmed?: boolean }) => {
      if (message.type === "LIST_CLICK_TARGETS") return { ok: true, targets, page: { title: page.title, url: page.url } };
      confirmedClick = Boolean(message.confirmed);
      return confirmedClick ? { ok: true, summary: "Published" } : { ok: false, requiresConfirmation: true, summary: "Confirm publish" };
    });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      target: "t0", confidence: 0.99, confident: true, ranked: [{ id: "t0", probability: 0.99 }],
    }));
    h.calls([{ call_id: "fast-1", name: "find_and_click", arguments: '{"goal":"publish the post"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onConfirmation).toHaveBeenCalledOnce());
    await h.callbacks.onConfirmation.mock.calls[0]![2](true);
    await vi.waitFor(() => expect(confirmedClick).toBe(true));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls.filter(([message]) => message.type === "LIST_CLICK_TARGETS")).toHaveLength(1);
    await h.session.stop();
  });

  it("does not run an approval callback from a stopped session", async () => {
    const h = await harness();
    h.sendMessage.mockResolvedValue({ ok: false, requiresConfirmation: true, summary: "Confirm publish" });
    h.calls([{ call_id: "call-1", name: "click", arguments: '{"text":"Publish"}' }]);
    await vi.waitFor(() => expect(h.callbacks.onConfirmation).toHaveBeenCalledOnce());
    const approve = h.callbacks.onConfirmation.mock.calls[0]![2];
    await h.session.stop();
    h.channel.send.mockClear();
    await approve(true);
    await Promise.resolve();
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.channel.send).not.toHaveBeenCalled();
  });
});
