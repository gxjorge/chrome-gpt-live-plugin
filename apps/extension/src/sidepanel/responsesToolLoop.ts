import type { ActionResult } from "@chrome-gpt-live/shared";
import {
  createToolOutputEvent, MAX_TOOL_EVENT_BYTES, MAX_PENDING_TOOL_BYTES,
  MAX_PENDING_TOOL_ITEMS, MIN_TOOL_EVENT_BYTES, utf8Bytes,
} from "./toolOutput";

export type FunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

type ResponseBatch = {
  delegationId: string;
  calls: Map<string, FunctionCall>;
  readyCalls: Set<string>;
  completed: boolean;
  cancelled: boolean;
  submitted: boolean;
};

type ToolLoopCallbacks = {
  execute: (call: FunctionCall, signal: AbortSignal) => Promise<ActionResult>;
  send: (event: object) => void;
  onError: (message: string) => void;
};

export class ResponsesToolLoop {
  private readonly responses = new Map<string, ResponseBatch>();
  private readonly activeResponses = new Map<string, string>();
  private readonly itemResponses = new Map<string, string>();
  private readonly itemCalls = new Map<string, string>();
  private readonly controller = new AbortController();
  private queue = Promise.resolve();
  private hasUncontinuedOutputs = false;
  private pendingOutputBytes = 0;
  private pendingOutputItems = 0;

  constructor(private readonly callbacks: ToolLoopCallbacks) {}

  get busy(): boolean {
    return [...this.responses.values()].some((batch) =>
      !batch.cancelled && (!batch.completed || (batch.calls.size > 0 && !batch.submitted)),
    );
  }

  get stopped(): boolean {
    return this.controller.signal.aborted;
  }

  handleEvent(envelope: Record<string, unknown>): void {
    if (this.controller.signal.aborted || envelope.type !== "response.event") {
      return;
    }
    const event = envelope.event;
    if (!isRecord(event)) {
      this.fail("GPT-Live returned an invalid delegated response event.");
      return;
    }
    const type = event.type;
    if (![
      "response.created", "response.in_progress", "response.completed",
      "response.failed", "response.incomplete", "response.cancelled",
      "response.output_item.added", "response.output_item.done", "response.function_call_arguments.done", "error",
    ].includes(String(type))) {
      return;
    }
    const delegationId = envelope.delegation_id;
    if (typeof delegationId !== "string") {
      this.fail("GPT-Live returned a response without its delegation ID.");
      return;
    }

    if (type === "error") {
      this.fail(typeof event.message === "string" ? event.message : "Astra's delegated response failed.");
      return;
    }
    if (type === "response.function_call_arguments.done") {
      const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
      const responseId = itemId ? this.itemResponses.get(itemId) : undefined;
      const batch = responseId ? this.responses.get(responseId) : undefined;
      const callId = itemId ? this.itemCalls.get(itemId) : undefined;
      const call = callId ? batch?.calls.get(callId) : undefined;
      if (batch && call && batch.delegationId === delegationId && !batch.completed && typeof event.arguments === "string") {
        call.arguments = event.arguments;
        batch.readyCalls.add(call.call_id);
      }
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      if (!isRecord(event.item) || event.item.type !== "function_call") {
        return;
      }
      const responseId = typeof event.item.id === "string" && this.itemResponses.has(event.item.id)
        ? this.itemResponses.get(event.item.id)
        : typeof event.response_id === "string"
        ? event.response_id
        : this.activeResponses.get(delegationId);
      const batch = responseId ? this.responses.get(responseId) : undefined;
      if (!batch || batch.delegationId !== delegationId) {
        this.fail("Astra returned a tool call without a matching response.");
        return;
      }
      const item = event.item;
      if (typeof item.call_id !== "string" || typeof item.name !== "string" ||
        (type === "response.output_item.done" && typeof item.arguments !== "string")) {
        this.fail("Astra returned a malformed function call.");
        return;
      }
      if (!batch.completed && !batch.cancelled) {
        this.collectCall(batch, item, type === "response.output_item.done");
        if (typeof item.id === "string" && responseId) {
          this.itemResponses.set(item.id, responseId);
          this.itemCalls.set(item.id, item.call_id);
        }
      }
      return;
    }

    const response = event.response;
    if (!isRecord(response) || typeof response.id !== "string") {
      this.fail("Astra returned a response lifecycle event without its response ID.");
      return;
    }
    let batch = this.responses.get(response.id);
    if (!batch) {
      batch = { delegationId, calls: new Map(), readyCalls: new Set(), completed: false, cancelled: false, submitted: false };
      this.responses.set(response.id, batch);
    }
    if (batch.delegationId !== delegationId) {
      this.fail("Astra returned a response with a mismatched delegation ID.");
      return;
    }
    if (type === "response.created" || type === "response.in_progress") {
      if (!batch.completed && !batch.cancelled) {
        this.activeResponses.set(delegationId, response.id);
      }
      return;
    }
    if (type !== "response.completed") {
      batch.cancelled = true;
      const detail = isRecord(response.error) && typeof response.error.message === "string"
        ? response.error.message
        : String(type);
      this.callbacks.onError(`Astra did not complete its response: ${detail}`);
      this.continueWhenReady();
      return;
    }
    if (batch.completed || batch.cancelled) {
      return;
    }
    if (Array.isArray(response.output)) {
      for (const item of response.output) {
        if (isRecord(item) && item.type === "function_call") {
          this.collectCall(batch, item, true);
        }
      }
    }
    batch.completed = true;
    if (batch.calls.size === 0) {
      this.continueWhenReady();
      return;
    }

    // Output-item events can precede registration of the full pending-call set.
    // Wait for response.completed, then serialize batches so confirmations cannot overlap.
    const completedBatch = batch;
    this.queue = this.queue
      .then(() => this.runBatch(completedBatch))
      .catch((cause: unknown) => {
        this.fail(`Could not submit Astra's tool results: ${errorMessage(cause)}`);
      });
  }

  stop(): void {
    this.controller.abort();
    this.responses.clear();
    this.activeResponses.clear();
    this.itemResponses.clear();
    this.itemCalls.clear();
  }

  private collectCall(batch: ResponseBatch, item: Record<string, unknown>, ready: boolean): void {
    if (typeof item.call_id !== "string" || typeof item.name !== "string") {
      this.fail("Astra returned a malformed function call.");
      return;
    }
    if (!batch.readyCalls.has(item.call_id) || ready) {
      batch.calls.set(item.call_id, {
        type: "function_call", call_id: item.call_id, name: item.name,
        arguments: typeof item.arguments === "string" ? item.arguments : "",
      });
    }
    if (ready && typeof item.arguments === "string") batch.readyCalls.add(item.call_id);
  }

  private async runBatch(batch: ResponseBatch): Promise<void> {
    const outputs: { call: FunctionCall; result: ActionResult }[] = [];
    const signal = this.controller.signal;
    const remainingBytes = MAX_PENDING_TOOL_BYTES - this.pendingOutputBytes;
    if (this.pendingOutputItems + batch.calls.size > MAX_PENDING_TOOL_ITEMS ||
      remainingBytes < batch.calls.size * MIN_TOOL_EVENT_BYTES) {
      this.fail("The pending tool batch exceeds the live service's context limit. No further browser actions were taken; start a new conversation.");
      return;
    }
    const eventBudget = Math.min(MAX_TOOL_EVENT_BYTES, Math.floor(remainingBytes / batch.calls.size));
    for (const call of batch.calls.values()) {
      if (signal.aborted || batch.cancelled) {
        return;
      }
      let result: ActionResult;
      try {
        if (batch.readyCalls.has(call.call_id)) {
          result = await this.callbacks.execute(call, signal);
        } else {
          result = { ok: false, summary: "The tool arguments were not fully received. No browser action was taken; request the tool again." };
          this.callbacks.onError(result.summary);
        }
      } catch (cause) {
        result = { ok: false, summary: `Tool ${call.name} failed: ${errorMessage(cause)}` };
        if (!signal.aborted) {
          this.callbacks.onError(result.summary);
        }
      }
      outputs.push({ call, result });
    }
    if (signal.aborted || batch.cancelled) {
      return;
    }
    for (const { call, result } of outputs) {
      const event = createToolOutputEvent(call.call_id, result, eventBudget);
      this.callbacks.send(event);
      this.pendingOutputBytes += utf8Bytes(JSON.stringify(event));
      this.pendingOutputItems++;
    }
    batch.submitted = true;
    this.hasUncontinuedOutputs = true;
    this.continueWhenReady();
  }

  private continueWhenReady(): void {
    if (this.controller.signal.aborted || !this.hasUncontinuedOutputs) {
      return;
    }
    for (const batch of this.responses.values()) {
      if (!batch.cancelled && (!batch.completed || (batch.calls.size > 0 && !batch.submitted))) {
        return;
      }
    }
    this.callbacks.send({ type: "response.create", event_id: crypto.randomUUID() });
    this.pendingOutputBytes = 0;
    this.pendingOutputItems = 0;
    this.hasUncontinuedOutputs = false;
  }

  private fail(message: string): void {
    this.stop();
    this.callbacks.onError(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
