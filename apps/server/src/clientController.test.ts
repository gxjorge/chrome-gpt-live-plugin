import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastSnapshot } from "@chrome-gpt-live/shared";
import { buildApp } from "./app.js";
import { effectiveController, loadConfig, resolveFoundryConfiguration } from "./config.js";
import { buildNextActionQuestion, interpretNextAction, validateChoice } from "./decision.js";
import { readServerEvents } from "./clientController.js";

vi.mock("@azure/ai-projects", () => ({
  AIProjectClient: class { constructor() { throw new Error("Unexpected SDK call in a mocked client-controller test."); } },
}));

const configuration = {
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/test",
  decisionDeployment: "test-md1", browserControl: "md1-first" as const,
};
const credential = { getToken: vi.fn(async () => ({ token: "synthetic-unit-token", expiresOnTimestamp: 9999999999999 })) };
const snapshot: FastSnapshot = {
  documentId: "doc-1", snapshotId: "snapshot-1", url: "https://example.com/", title: "Test", text: "Menu",
  viewport: { x: 0, y: 0, width: 800, height: 600, scrollHeight: 600 },
  targets: [{ id: "t1", label: "Menu", kind: "button", state: "{}" }],
  operations: ["CLICK", "WAIT", "DONE", "HANDOFF"],
};
const choice = (selected: string, probabilities: Record<string, number>) => ({ type: "choice", choice: selected, probabilities });
const answers = {
  answers: {
    operation: choice("CLICK", { CLICK: 0.9, WAIT: 0.04, DONE: 0.03, HANDOFF: 0.03 }),
    click_target: choice("t1", { t1: 0.8, none: 0.2 }),
  },
};
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("MD-1 strict choice validation", () => {
  it("batches operation and speculative target questions on one shared state", () => {
    const request = buildNextActionQuestion("md1", "Open Menu", snapshot, []);
    expect(Object.keys(request.questions)).toEqual(["operation", "click_target"]);
    expect(request.state.page).toBe(snapshot);
    expect(interpretNextAction(answers, snapshot, 0.7)).toEqual({
      operation: "CLICK", targetId: "t1", confidence: 0.8, confident: true,
    });
  });
  it.each([
    { a: Number.NaN, b: 0 }, { a: Infinity, b: 0 }, { a: -0.1, b: 1.1 },
    { a: 0.8 }, { a: 0.8, b: 0.2, c: 0 }, { a: 0.8, b: 0.3 }, { a: 0.1, b: 0.9 },
  ])("rejects malformed distributions: %j", (probabilities) => {
    expect(() => validateChoice(choice("a", probabilities), ["a", "b"])).toThrow();
  });
  it("rejects inconsistent reported confidence and unknown selected IDs", () => {
    expect(() => validateChoice({ ...choice("a", { a: 0.8, b: 0.2 }), confidence: 0.2 }, ["a", "b"])).toThrow();
    expect(() => validateChoice(choice("outside", { a: 0.8, b: 0.2 }), ["a", "b"])).toThrow();
  });
  it("ignores an unused speculative target head and gates the operation confidence", () => {
    const payload = { answers: { operation: choice("WAIT", { CLICK: 0.1, WAIT: 0.6, DONE: 0.1, HANDOFF: 0.2 }), click_target: "invalid-unused-head" } };
    expect(interpretNextAction(payload, snapshot, 0.7)).toMatchObject({ operation: "WAIT", confident: false });
  });
});

describe("client-controller mode and release lock", () => {
  it("keeps default and unconfigured sessions on managed Astra", () => {
    const config = loadConfig({});
    expect(effectiveController(config).mode).toBe("astra");
    expect(effectiveController(config, "md1-first").reason).toContain("no decision deployment");
    expect(resolveFoundryConfiguration(config, configuration).controller?.reason).toContain("locked");
  });
  it("preserves environment precedence, including an explicit Astra override", () => {
    const resolved = resolveFoundryConfiguration(loadConfig({ BROWSER_CONTROL: "astra", MD1_CLIENT_DELEGATION_VERIFIED: "true" }), configuration);
    expect(resolved.values.browserControl).toBe("astra");
    expect(resolved.overrides.browserControl).toBe(true);
    expect(resolved.controller?.mode).toBe("astra");
  });
  it("does not acquire credentials or call either model when protocol-locked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({}), credential);
    try {
      const result = await app.inject({ method: "POST", url: "/api/decision/next-action", payload: { goal: "Open Menu", snapshot, history: [], configuration } });
      expect(result.statusCode).toBe(409);
      const fallback = await app.inject({ method: "POST", url: "/api/controller/round", payload: { runId: "run-1", round: 1, input: [{ role: "user", content: "test" }], configuration } });
      expect(fallback.statusCode).toBe(409);
      expect(credential.getToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); }
  }, 15000);
  it("creates client delegation only with the explicit option, deployment, and verified lock", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ session: { id: "live-1" }, transport: { sdp: "answer" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ MD1_CLIENT_DELEGATION_VERIFIED: "true" }), credential);
    try {
      const result = await app.inject({ method: "POST", url: "/api/live/session", payload: { sdp: "offer", configuration } });
      expect(result.statusCode).toBe(200);
      expect(result.json().controllerMode).toBe("md1-first");
      expect(JSON.parse(fetchMock.mock.calls[0]![1].body).session.delegation).toEqual({ type: "client" });
    } finally { await app.close(); }
  });
  it("makes one MD-1 request per step with no initial Astra call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(answers));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ MD1_CLIENT_DELEGATION_VERIFIED: "true" }), credential);
    try {
      const result = await app.inject({ method: "POST", url: "/api/decision/next-action", payload: { goal: "Open Menu", snapshot, history: [], configuration } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ operation: "CLICK", confident: true });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0]![0]).toContain("/providers/microsoft/v1/systemone");
    } finally { await app.close(); }
  });
  it("does not expose provider failure payloads and aborts in-flight MD-1 when its HTTP client disconnects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("synthetic-private-provider-detail"));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ MD1_CLIENT_DELEGATION_VERIFIED: "true" }), credential);
    let disconnected!: () => void;
    app.addHook("onRequest", async (_request, reply) => { disconnected = () => { reply.raw.emit("close"); }; });
    try {
      const failure = await app.inject({ method: "POST", url: "/api/decision/next-action", payload: {
        goal: "Open Menu", snapshot, history: [], configuration,
      } });
      expect(failure.statusCode).toBe(502);
      expect(failure.body).not.toContain("synthetic-private-provider-detail");
      let cancelled = false;
      fetchMock.mockImplementationOnce(async (_url: string, options: RequestInit) => {
        const signal = options.signal!;
        const response = new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => {
          cancelled = true;
          reject(new Error("synthetic-provider-cancelled"));
        }, { once: true }));
        disconnected();
        return response;
      });
      await expect(app.inject({ method: "POST", url: "/api/decision/next-action", payload: {
        goal: "Open Menu", snapshot, history: [], configuration,
      } })).rejects.toThrow("response destroyed before completion");
      expect(cancelled).toBe(true);
    } finally { await app.close(); }
  });
});

describe("stateless streamed Astra fallback", () => {
  it("streams only public text and returns complete opaque continuation items without an MD-1 tool", async () => {
    const output = [
      { type: "reasoning", id: "rs-1", summary: [], encrypted_content: "opaque-synthetic-context" },
      { type: "function_call", call_id: "call-1", id: "fc-1", name: "scroll", arguments: '{"direction":"down","amount":700}' },
    ];
    const events = [
      { type: "response.reasoning_text.delta", delta: "must-not-be-streamed" },
      { type: "response.output_text.delta", item_id: "msg-1", delta: "Public answer" },
      { type: "response.completed", response: { output } },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ MD1_CLIENT_DELEGATION_VERIFIED: "true" }), credential);
    try {
      const result = await app.inject({ method: "POST", url: "/api/controller/round", payload: {
        runId: "run-1", round: 2, input: [{ role: "user", content: "test" }, ...output,
          { type: "function_call_output", call_id: "call-1", output: '{"ok":true}' }], configuration,
      } });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toContain("application/x-ndjson");
      const lines = result.body.trim().split("\n").map((line) => JSON.parse(line));
      expect(lines).toEqual([{ type: "text", itemId: "msg-1", delta: "Public answer" }, { type: "completed", output, text: "" }]);
      expect(result.body).not.toContain("must-not-be-streamed");
      const request = JSON.parse(fetchMock.mock.calls[0]![1].body);
      expect(request).toMatchObject({ store: false, stream: true, include: ["reasoning.encrypted_content"] });
      expect(request.input[1]).toEqual(output[0]);
      expect(request.tools.some((tool: { name: string }) => tool.name === "find_and_click")).toBe(false);
    } finally { await app.close(); }
  });
  it("rejects the exact Responses-round and history-byte overflow before calling a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = buildApp(loadConfig({ MD1_CLIENT_DELEGATION_VERIFIED: "true" }), credential);
    try {
      for (const invalid of [{ round: 17, input: [{ role: "user", content: "test" }] },
        { round: 1, input: [{ role: "user", content: "x".repeat(250001) }] }]) {
        const response = await app.inject({ method: "POST", url: "/api/controller/round", payload: { runId: "run-1", ...invalid, configuration } });
        expect(response.statusCode).toBe(400);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("parses CRLF events split across chunks and rejects truncated events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ['data: {"type":"test"}\r', '\n\r', '\n']) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readServerEvents(body)) events.push(event);
    expect(events).toEqual([{ type: "test" }]);
    const truncated = new Response('data: {"type":"test"}').body!;
    await expect(async () => { for await (const _event of readServerEvents(truncated)) { /* exhaust */ } }).rejects.toThrow("incomplete");
  });
  it("bounds provider events by UTF-8 bytes rather than JavaScript character count", async () => {
    const oversized = new Response(`data: ${JSON.stringify({ type: "test", text: "\u00e9".repeat(125001) })}\n\n`).body!;
    await expect(async () => { for await (const _event of readServerEvents(oversized)) { /* exhaust */ } })
      .rejects.toThrow("size budget");
  });
});
