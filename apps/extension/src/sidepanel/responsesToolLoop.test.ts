import type { ActionResult } from "@chrome-gpt-live/shared";
import { describe, expect, it, vi } from "vitest";
import { ResponsesToolLoop, type FunctionCall } from "./responsesToolLoop";
import { MAX_PENDING_TOOL_BYTES, utf8Bytes } from "./toolOutput";

function harness() {
  const execute = vi.fn<(call: FunctionCall, signal: AbortSignal) => Promise<ActionResult>>()
    .mockResolvedValue({ ok: true, summary: "Done" });
  const send = vi.fn<(event: object) => void>();
  const onError = vi.fn();
  const loop = new ResponsesToolLoop({ execute, send, onError });
  const receive = (event: object, delegationId = "delegation-1") => loop.handleEvent({
    type: "response.event", delegation_id: delegationId, event,
  });
  const start = (responseId = "response-1", delegationId = "delegation-1") => receive({
    type: "response.in_progress", response: { id: responseId, status: "in_progress" },
  }, delegationId);
  const call = (callId: string, delegationId = "delegation-1") => receive({
    type: "response.output_item.done",
    item: { type: "function_call", call_id: callId, name: "get_page_context", arguments: "{}" },
  }, delegationId);
  const complete = (responseId = "response-1", delegationId = "delegation-1") => receive({
    type: "response.completed", response: { id: responseId, status: "completed" },
  }, delegationId);
  return { loop, execute, send, onError, receive, start, call, complete };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const success: ActionResult = { ok: true, summary: "Done" };

describe("Responses tool continuation", () => {
  it("keeps a large batch below the backend input limit and renews the budget after continuation", async () => {
    const h = harness();
    h.execute.mockResolvedValue({ ok: true, summary: "Read data.", data: { analysis: "\u6f22".repeat(20000) } });
    for (let round = 0; round < 8; round++) {
      const responseId = `response-${round}`;
      h.start(responseId);
      for (let call = 0; call < 8; call++) h.call(`call-${round}-${call}`);
      h.complete(responseId);
      await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes((round + 1) * 9));
      const events = h.send.mock.calls.slice(round * 9, (round + 1) * 9 - 1).map(([event]) => event);
      expect(events.reduce((bytes, event) => bytes + utf8Bytes(JSON.stringify(event)), 0)).toBeLessThanOrEqual(MAX_PENDING_TOOL_BYTES);
    }
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(64);
  });

  it("rejects an unrepresentable batch before performing any browser action", async () => {
    const h = harness();
    h.start();
    for (let call = 0; call < 101; call++) h.call(`call-${call}`);
    h.complete();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.loop.stopped).toBe(true);
  });

  it("reconciles function calls included in the terminal response when item-done events are missing", async () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.completed", response: { id: "response-1", output: [
      { type: "function_call", call_id: "call-1", name: "get_page_context", arguments: "{}" },
    ] } });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("uses completed argument events without executing partial argument fragments", async () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.output_item.added", item: {
      id: "item-1", type: "function_call", call_id: "call-1", name: "get_page_context", arguments: "",
    } });
    h.receive({ type: "response.function_call_arguments.done", item_id: "item-1", arguments: "{}" });
    expect(h.execute).not.toHaveBeenCalled();
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0]?.[0].arguments).toBe("{}");
  });

  it("submits an explicit failure for a registered call whose arguments never completed, without taking an action", async () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.output_item.added", item: {
      id: "item-1", type: "function_call", call_id: "call-1", name: "click", arguments: '{"text":',
    } });
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ item: { call_id: "call-1", output: expect.stringContaining('"ok":false') } });
  });

  it("keeps item ownership when response streams in the same delegation overlap", async () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.output_item.added", item: {
      id: "item-1", type: "function_call", call_id: "call-1", name: "get_page_context", arguments: "",
    } });
    h.start("response-2");
    h.receive({ type: "response.output_item.done", item: {
      id: "item-1", type: "function_call", call_id: "call-1", name: "get_page_context", arguments: "{}",
    } });
    h.complete();
    h.call("call-2");
    h.complete("response-2");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.execute.mock.calls.map(([call]) => call.call_id)).toEqual(["call-1", "call-2"]);
  });

  it("waits for response.completed even when a single tool finishes immediately", async () => {
    const h = harness();
    h.start();
    h.call("call-1");
    await Promise.resolve();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();

    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      type: "response.item.create",
      item: { type: "function_call_output", call_id: "call-1" },
    });
    expect(h.send.mock.calls[1]?.[0]).toMatchObject({ type: "response.create" });
  });

  it("submits every result before continuing once, including slow confirmations", async () => {
    const h = harness();
    const pending = deferred<ActionResult>();
    h.execute.mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise);
    h.start();
    h.call("call-1");
    h.call("call-2");
    h.complete();

    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledTimes(2));
    expect(h.send).not.toHaveBeenCalled();
    pending.resolve({ ok: false, summary: "The user declined the action." });
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.send.mock.calls.map(([event]) => event)).toMatchObject([
      { type: "response.item.create", item: { call_id: "call-1", output: JSON.stringify(success) } },
      { type: "response.item.create", item: { call_id: "call-2", output: JSON.stringify({ ok: false, summary: "The user declined the action." }) } },
      { type: "response.create" },
    ]);
  });

  it("returns a failure output for a thrown tool instead of leaving it pending", async () => {
    const h = harness();
    h.execute.mockRejectedValueOnce(new Error("The tab closed"));
    h.start();
    h.call("call-1");
    h.call("call-2");
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({
      item: { call_id: "call-1", output: JSON.stringify({ ok: false, summary: "Tool get_page_context failed: The tab closed" }) },
    });
    expect(h.onError).toHaveBeenCalledWith("Tool get_page_context failed: The tab closed");
  });

  it("does not re-execute duplicate calls or duplicate terminal events", async () => {
    const h = harness();
    h.start();
    h.call("call-1");
    h.call("call-1");
    h.complete();
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    h.call("call-1");
    h.complete();
    await Promise.resolve();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("handles continuation responses with the same delegation ID", async () => {
    const h = harness();
    h.start();
    h.call("call-1");
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(2));
    h.start("response-2");
    h.call("call-2");
    h.complete("response-2");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(4));
    expect(h.execute.mock.calls.map(([call]) => call.call_id)).toEqual(["call-1", "call-2"]);
  });

  it("waits for all pending delegations and serializes their tools", async () => {
    const h = harness();
    const pending = deferred<ActionResult>();
    h.execute.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(success);
    h.start();
    h.call("call-1");
    h.start("response-2", "delegation-2");
    h.call("call-2", "delegation-2");
    h.complete();
    h.complete("response-2", "delegation-2");
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledOnce());
    expect(h.send).not.toHaveBeenCalled();
    pending.resolve(success);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.send.mock.calls.map(([event]) => event)).toMatchObject([
      { type: "response.item.create", item: { call_id: "call-1" } },
      { type: "response.item.create", item: { call_id: "call-2" } },
      { type: "response.create" },
    ]);
  });

  it("waits for an overlapping response to finish emitting its calls", async () => {
    const h = harness();
    h.start();
    h.call("call-1");
    h.start("response-2", "delegation-2");
    h.complete();
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce());
    expect(h.send.mock.calls[0]?.[0]).toMatchObject({ type: "response.item.create" });
    h.call("call-2", "delegation-2");
    h.complete("response-2", "delegation-2");
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(3));
    expect(h.send.mock.calls[2]?.[0]).toMatchObject({ type: "response.create" });
  });

  it("does not execute calls from failed, cancelled, or incomplete responses", async () => {
    for (const status of ["failed", "cancelled", "incomplete"]) {
      const h = harness();
      h.start();
      h.call("call-1");
      h.receive({ type: `response.${status}`, response: { id: "response-1", status } });
      h.complete();
      await Promise.resolve();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.onError).toHaveBeenCalledOnce();
    }
  });

  it("does not continue a text-only response", async () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.output_item.done", item: { type: "message" } });
    h.complete();
    await Promise.resolve();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("does not send late outputs or execute queued actions after stopping", async () => {
    const h = harness();
    const pending = deferred<ActionResult>();
    h.execute.mockReturnValueOnce(pending.promise);
    h.start();
    h.call("call-1");
    h.call("call-2");
    h.complete();
    await vi.waitFor(() => expect(h.execute).toHaveBeenCalledOnce());
    h.loop.stop();
    pending.resolve(success);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.execute.mock.calls[0]?.[1].aborted).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("never continues after failing to submit an output", async () => {
    const h = harness();
    h.send.mockImplementation(() => { throw new Error("Channel closed"); });
    h.start();
    h.call("call-1");
    h.complete();
    await vi.waitFor(() => expect(h.onError).toHaveBeenCalledOnce());
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.onError).toHaveBeenCalledWith("Could not submit Astra's tool results: Channel closed");
  });

  it("reports malformed call metadata instead of executing an untracked action", () => {
    const h = harness();
    h.start();
    h.receive({ type: "response.output_item.done", item: { type: "function_call", name: "click" } });
    h.complete();
    expect(h.onError).toHaveBeenCalledWith("Astra returned a malformed function call.");
    expect(h.execute).not.toHaveBeenCalled();
  });
});
