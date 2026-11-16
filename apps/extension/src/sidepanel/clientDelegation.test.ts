import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastSnapshot } from "@chrome-gpt-live/shared";
import { ClientDelegation, verifiedGoal } from "./clientDelegation";

const initial: FastSnapshot = {
  documentId: "doc-1", snapshotId: "snapshot-1", url: "https://example.com/", title: "Test", text: "Updates",
  viewport: { x: 0, y: 0, width: 800, height: 600, scrollHeight: 1800 },
  targets: [{ id: "t1", label: "Updates", kind: "input", state: '{"checked":false}' }],
  operations: ["CLICK", "SCROLL_DOWN", "WAIT", "DONE", "HANDOFF"],
};
const user = (delta = "Check Updates.", start = 100, end = 200, id = "user-1") => ({
  type: "session.input_transcript.delta", event_id: id, delta, start_ms: start, end_ms: end,
});
const delegation = (id = "delegation-1", offset = 1000) => ({
  type: "session.delegation.created", event_id: `event-${id}`, offset_ms: offset,
  delegation: { type: "delegation", id, target: "client" },
});
const finalOutput = [{ type: "message", id: "msg-1", role: "assistant", content: [{ type: "output_text", text: "Observed result." }] }];
const stream = (output = finalOutput) => new Response([
  JSON.stringify({ type: "text", itemId: "msg-1", delta: "Observed result." }),
  JSON.stringify({ type: "completed", output, text: "Observed result." }),
  "",
].join("\n"));

function harness(operations = ["CLICK", "DONE"], goal = "Check Updates.") {
  let snapshotIndex = 0;
  const sendMessage = vi.fn(async (event: { type: string }) => {
    if (event.type === "FAST_SNAPSHOT") return { ok: true, snapshot: {
      ...initial, snapshotId: `snapshot-${snapshotIndex++}`, targets: initial.targets.map((target) => ({
        ...target, state: snapshotIndex > 1 ? '{"checked":true}' : target.state,
      })),
    } };
    if (event.type === "FAST_EXECUTE") return { ok: true, summary: "Input delivered", outcome: "executed" };
    return { ok: true };
  });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  let decision = 0;
  const fetchMock = vi.fn(async (url: string) => url.includes("/next-action") ?
    Response.json({ operation: operations[Math.min(decision++, operations.length - 1)], targetId: "t1", confidence: 0.9, confident: true }) : stream());
  vi.stubGlobal("fetch", fetchMock);
  const callbacks = {
    execute: vi.fn(async () => ({ ok: true, summary: "Fresh current page", data: { url: initial.url } })),
    send: vi.fn(), step: vi.fn(), activity: vi.fn(), text: vi.fn(), busy: vi.fn(), error: vi.fn(), diagnostic: vi.fn(),
  };
  const client = new ClientDelegation("session-1", 42, { browserControl: "md1-first" }, callbacks);
  const start = () => { client.handle(user(goal)); client.handle(delegation()); };
  const finish = async () => { await vi.waitFor(() => expect(callbacks.busy).toHaveBeenLastCalledWith(false)); };
  return { client, callbacks, sendMessage, fetchMock, start, finish };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("MD-1-first client routing", () => {
  it("takes multiple grounded steps without an initial Astra call and verifies the requested checkbox state", async () => {
    const h = harness();
    h.start();
    await h.finish();
    expect(h.fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("/next-action"), expect.stringContaining("/next-action"),
    ]);
    expect(h.callbacks.execute).not.toHaveBeenCalled();
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(1);
    expect(h.callbacks.send).toHaveBeenCalledWith(expect.objectContaining({
      delegation_id: "delegation-1", content: expect.stringContaining("independently observed"),
    }));
    h.client.close();
  });
  it("does not equate DONE with success when goal evidence is unavailable", async () => {
    const h = harness(["DONE"], "Open the article.");
    h.start();
    await h.finish();
    expect(h.fetchMock.mock.calls.some(([url]) => url.includes("/controller/round"))).toBe(true);
    expect(h.callbacks.activity).toHaveBeenCalledWith(expect.stringContaining("code-owned goal evidence"));
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(0);
    h.client.close();
  });
  it("routes reading, typing and PDFs through Astra without a speculative MD-1 action", async () => {
    const h = harness([], "Summarize this PDF.");
    h.start();
    await h.finish();
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(h.fetchMock.mock.calls[0]![0]).toContain("/controller/round");
    expect(h.sendMessage).not.toHaveBeenCalled();
    h.client.close();
  });
  it("ignores duplicate delegation deliveries without executing another click", async () => {
    const h = harness();
    h.start();
    h.client.handle(delegation());
    h.client.handle({ ...delegation(), event_id: "same-delegation-new-envelope" });
    await h.finish();
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(1);
    h.client.close();
  });
  it("hands low confidence to Astra and keeps that delegation sticky", async () => {
    const h = harness();
    h.fetchMock.mockResolvedValueOnce(Response.json({ operation: "CLICK", targetId: "t1", confidence: 0.4, confident: false }));
    h.start();
    await h.finish();
    expect(h.fetchMock.mock.calls.filter(([url]) => url.includes("/next-action"))).toHaveLength(1);
    expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_EXECUTE")).toBe(false);
    expect(h.callbacks.activity).toHaveBeenCalledWith(expect.stringContaining("MD-1 was uncertain"));
    h.client.close();
  });
  it("revokes a late decision on fresh user speech without executing stale input", async () => {
    const h = harness();
    let release!: (value: Response) => void;
    h.fetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    h.start();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledOnce());
    h.client.handle(user("Actually, stop.", 1100, 1200, "user-2"));
    release(Response.json({ operation: "CLICK", targetId: "t1", confidence: 0.9, confident: true }));
    await h.finish();
    expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_EXECUTE")).toBe(false);
    expect(h.callbacks.send).not.toHaveBeenCalled();
    h.client.close();
  });
  it("Stop cancels a pending decision while retaining the client voice-session owner", async () => {
    const h = harness();
    let release!: (value: Response) => void;
    h.fetchMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    h.start();
    await vi.waitFor(() => expect(h.fetchMock).toHaveBeenCalledOnce());
    h.client.stop();
    release(Response.json({ operation: "CLICK", targetId: "t1", confidence: 0.9, confident: true }));
    await h.finish();
    expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_EXECUTE")).toBe(false);
    expect(h.callbacks.activity).toHaveBeenCalledWith(expect.stringContaining("Voice conversation remains connected"));
    h.client.close();
  });
  it("records an uncertain attempted mutation before fallback and never retries it", async () => {
    const h = harness();
    h.sendMessage.mockImplementation(async (event) => {
      if (event.type === "FAST_SNAPSHOT") return { ok: true, snapshot: initial };
      if (event.type === "FAST_EXECUTE") throw new Error("Port closed after delivery");
      return { ok: true };
    });
    h.start();
    await h.finish();
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(1);
    const fallback = h.fetchMock.mock.calls.find(([url]) => url.includes("/controller/round"));
    expect(fallback).toBeDefined();
    const request = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => String(url).includes("/controller/round"))![1]!.body));
    expect(request.input[0].content).toContain('"outcome":"uncertain"');
    expect(request.input[0].content).toContain('Updates');
    expect(h.callbacks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ name: "get_page_context" }), expect.any(AbortSignal), expect.any(String),
    );
    h.client.close();
  });
  it("revokes the run immediately at its deadline while a Chrome action result is still pending", async () => {
    const h = harness();
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => milliseconds === 60000 ? deadline.signal : timeout(milliseconds));
    let release!: (value: { ok: boolean; outcome: string; summary: string }) => void;
    const pending = new Promise<{ ok: boolean; outcome: string; summary: string }>((resolve) => { release = resolve; });
    const ordinaryMessage = h.sendMessage.getMockImplementation()!;
    h.sendMessage.mockImplementation((event) => event.type === "FAST_EXECUTE" ? pending : ordinaryMessage(event));
    h.start();
    await vi.waitFor(() => expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_EXECUTE")).toBe(true));
    expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_CANCEL")).toBe(false);
    deadline.abort();
    expect(h.sendMessage.mock.calls.some(([event]) => event.type === "FAST_CANCEL")).toBe(true);
    expect(h.callbacks.execute).not.toHaveBeenCalled();
    release({ ok: false, outcome: "uncertain", summary: "Delivery could not be confirmed." });
    await h.finish();
    expect(h.callbacks.activity).toHaveBeenCalledWith(expect.stringContaining("Astra handoff"));
    h.client.close();
  });
  it("stops after three no-progress waits", async () => {
    const h = harness(["WAIT"], "Scroll down.");
    h.sendMessage.mockImplementation(async (event) => event.type === "FAST_SNAPSHOT"
      ? { ok: true, snapshot: initial } : event.type === "FAST_EXECUTE"
        ? { ok: true, outcome: "executed", summary: "Waited" } : { ok: true });
    h.start();
    await h.finish();
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(3);
    h.client.close();
  });
  it("allows exactly eight fast attempts before handing off", async () => {
    const h = harness(["SCROLL_DOWN"], "Scroll down.");
    h.start();
    await h.finish();
    expect(h.sendMessage.mock.calls.filter(([event]) => event.type === "FAST_EXECUTE")).toHaveLength(8);
    expect(h.callbacks.activity).toHaveBeenCalledWith(expect.stringContaining("Fast action budget"));
    h.client.close();
  });
});

describe("app-owned Astra continuation", () => {
  it("executes a complete tool batch sequentially and preserves encrypted reasoning and every required output", async () => {
    const h = harness([], "Read the page.");
    const output = [
      { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "opaque-test-value" },
      { type: "function_call", call_id: "call-1", name: "scroll", arguments: '{"direction":"down","amount":700}' },
      { type: "function_call", call_id: "call-2", name: "get_page_context", arguments: "{}" },
    ];
    h.fetchMock.mockResolvedValueOnce(new Response(`${JSON.stringify({ type: "completed", output, text: "" })}\n`));
    h.start();
    await h.finish();
    const calls = h.callbacks.execute.mock.calls;
    expect(calls).toHaveLength(3);
    const requests = vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options!.body)));
    expect(requests[1].input).toContainEqual(output[0]);
    expect(requests[1].input.filter((item: { type: string }) => item.type === "function_call_output")).toHaveLength(2);
    expect(h.callbacks.text).toHaveBeenCalledWith(expect.stringContaining("msg-1"), "Observed result.", false);
    expect(h.callbacks.error).not.toHaveBeenCalled();
    h.client.close();
  });
  it("never repeats a function call ID returned in another round", async () => {
    const h = harness([], "Read the page.");
    const output = [{ type: "function_call", call_id: "duplicate", name: "scroll", arguments: '{"direction":"down","amount":700}' }];
    h.fetchMock.mockImplementation(async () => new Response(`${JSON.stringify({ type: "completed", output, text: "" })}\n`));
    h.start();
    await h.finish();
    expect(h.callbacks.execute).toHaveBeenCalledTimes(2);
    expect(h.callbacks.error).toHaveBeenCalledWith(expect.stringContaining("repeated a function call ID"));
    h.client.close();
  });
  it("rejects a truncated fallback stream without reporting success", async () => {
    const h = harness([], "Read the page.");
    h.fetchMock.mockResolvedValueOnce(new Response('{"type":"completed"'));
    h.start();
    await h.finish();
    expect(h.callbacks.error).toHaveBeenCalledWith(expect.stringContaining("incomplete"));
    expect(h.callbacks.send).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("before a verified task outcome") }));
    h.client.close();
  });
  it("caps fallback at sixteen rounds and sixteen total tool attempts", async () => {
    const h = harness([], "Read the page.");
    let round = 0;
    h.fetchMock.mockImplementation(async () => new Response(`${JSON.stringify({
      type: "completed", text: "", output: [{
        type: "function_call", call_id: `call-${++round}`, name: "get_page_context", arguments: "{}",
      }],
    })}\n`));
    h.start();
    await h.finish();
    expect(h.fetchMock).toHaveBeenCalledTimes(16);
    expect(h.callbacks.execute).toHaveBeenCalledTimes(16);
    expect(h.callbacks.error).toHaveBeenCalledWith(expect.stringContaining("response-round budget"));
    h.client.close();
  });
});

describe("code-owned fast completion evidence", () => {
  it("requires an executed click and exact requested checked state", () => {
    const done = { ...initial, targets: [{ ...initial.targets[0]!, state: '{"checked":true}' }] };
    expect(verifiedGoal("Check Updates.", initial, done, [])).toBe(false);
    expect(verifiedGoal("Check Updates.", initial, done, [{ operation: "CLICK", outcome: "executed", summary: "clicked" }])).toBe(true);
    expect(verifiedGoal("Uncheck Updates.", initial, done, [{ operation: "CLICK", outcome: "executed", summary: "clicked" }])).toBe(false);
  });
});
