import {
  FAST_LIMITS, controllerStreamEventSchema, fastDecisionResponseSchema, fastSnapshotResponseSchema,
  fastStepResultSchema, type ActionResult, type ControllerItem, type FastScope, type FastSnapshot,
  type FastStepResult, type FoundryConfiguration,
} from "@chrome-gpt-live/shared";
import { ClientTaskContext, type ClientTaskCandidate } from "./clientTaskContext";
import type { FunctionCall } from "./responsesToolLoop";
import { companionFetch } from "./companion";
import { withDeadline } from "./activity";
import { createToolOutputEvent, MAX_TOOL_EVENT_BYTES, utf8Bytes } from "./toolOutput";

type Attempt = { operation: "CLICK" | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "HANDOFF"; summary: string; outcome: string };
type Callbacks = {
  execute: (call: FunctionCall, signal: AbortSignal, preventReplayRunId?: string) => Promise<ActionResult>;
  send: (event: object) => void;
  step: (id: string, label: string, result?: ActionResult, durationMs?: number) => void;
  activity: (label: string) => void;
  text: (id: string, text: string, done: boolean) => void;
  busy: (value: boolean) => void;
  error: (message: string) => void;
  diagnostic: (event: object) => void;
  currentTab?: () => number | undefined;
};

export class ClientDelegation {
  private readonly context: ClientTaskContext;
  private queue = Promise.resolve();
  private scope: FastScope | undefined;
  private readonly recent: Attempt[] = [];
  private uncertain = false;

  constructor(sessionId: string, tabId: number, private readonly configuration: FoundryConfiguration | undefined,
    private readonly callbacks: Callbacks) {
    this.context = new ClientTaskContext(sessionId, tabId);
  }

  handle(event: unknown): void {
    const update = this.context.accept(event);
    if (this.scope && update.status !== "ignored" && update.status !== "candidate") {
      // Revocation is immediate; waiting for the previous queue entry would allow stale input.
      if (update.status !== "transcript" || update.speaker === "user") this.revoke();
    }
    if (update.status === "blocked") {
      this.callbacks.activity(`Client task paused: ${update.reason}. Please restate the complete request.`);
      return;
    }
    if (update.status !== "candidate") return;
    this.revoke();
    const { candidate } = update;
    this.queue = this.queue.then(async () => {
      if (!this.context.isCurrent(candidate)) return;
      this.callbacks.busy(true);
      try { await this.run(candidate); }
      catch (cause) {
        if (!candidate.signal.aborted) {
          this.callbacks.send(this.context.contextAppend(candidate, "Browser work stopped before a verified task outcome. Inspect the page before repeating any action.", "commentary"));
          this.callbacks.error(`Client controller stopped: ${message(cause)} Inspect the page before repeating an action.`);
        }
      } finally {
        this.revoke();
        this.callbacks.busy(false);
      }
    });
  }

  stop(): void {
    this.context.cancel();
    this.revoke();
    this.callbacks.busy(false);
    this.callbacks.activity("Browser task stopped. Voice conversation remains connected.");
  }

  close(): void {
    this.context.close();
    this.revoke();
  }

  private revoke(): void {
    const scope = this.scope;
    this.scope = undefined;
    if (scope) void chrome.runtime.sendMessage({ type: "FAST_CANCEL", scope }).catch((cause: unknown) =>
      this.callbacks.diagnostic({ type: "client.cancel_delivery_failed", category: message(cause).includes("closed") ? "closed" : "transport" }));
  }

  private async run(task: ClientTaskCandidate): Promise<void> {
    const scope: FastScope = {
      sessionId: task.sessionId, runId: crypto.randomUUID(), revision: task.revision, tabId: task.tabId,
      expiresAtMs: Date.now() + FAST_LIMITS.durationMs,
    };
    const history: Attempt[] = [];
    let handoff = this.callbacks.currentTab && this.callbacks.currentTab() !== task.tabId ? "Conversation tab changed; Astra will handle the current tab." :
      this.uncertain ? "Earlier mutation delivery was uncertain; inspect state before any further input." :
      /\b(type|enter|fill|select|summari[sz]e|explain|read|describe|highlight|screenshot)\b/i.test(task.userText) ||
      !/^(?:please\s+)?(?:click|open|scroll|check|uncheck|expand|collapse|go to)\b/i.test(task.userText.trim()) ?
        "Task requires reading, reasoning, unsupported input, or clarification." : "";
    const fastDeadline = AbortSignal.timeout(FAST_LIMITS.durationMs);
    const signal = AbortSignal.any([task.signal, fastDeadline]);
    let initial: FastSnapshot | undefined;
    let previous: FastSnapshot | undefined;
    let waits = 0;
    if (!handoff) {
      const onAbort = () => { if (this.scope === scope) this.revoke(); };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        this.scope = scope;
        signal.throwIfAborted();
        await this.bind(scope, signal);
        for (let decisions = 0; decisions < FAST_LIMITS.decisions; decisions++) {
          signal.throwIfAborted();
          const snapshot = await this.snapshot(scope, signal);
          initial ??= snapshot;
          if (previous) {
            const unchanged = fingerprint(previous) === fingerprint(snapshot);
            waits = history.at(-1)?.operation === "WAIT" && unchanged ? waits + 1 : 0;
            if (waits >= FAST_LIMITS.noProgress) { handoff = "Repeated waits made no progress."; break; }
          }
          previous = snapshot;
          this.callbacks.activity("MD-1 is choosing the next grounded browser step");
          const response = await companionFetch("/api/decision/next-action", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ goal: task.userText.slice(0, 4000), snapshot, history, configuration: this.configuration }),
            signal,
          }, 9000);
          if (!response.ok) throw new Error(`MD-1 request failed (HTTP ${response.status}).`);
          const decision = fastDecisionResponseSchema.parse(await response.json());
          signal.throwIfAborted();
          if (!this.context.isCurrent(task)) return;
          this.callbacks.diagnostic({ type: "client.decision", decision: decisions + 1, confidence: decision.confidence });
          if (!decision.confident || !snapshot.operations.includes(decision.operation)) { handoff = "MD-1 was uncertain."; break; }
          if (decision.operation === "HANDOFF") { handoff = "MD-1 requested Astra for the remaining work."; break; }
          if (decision.operation === "DONE") {
            if (initial && verifiedGoal(task.userText, initial, snapshot, history)) {
              this.callbacks.send(this.context.contextAppend(task, "The requested browser state was independently observed. The task is complete.", "commentary"));
              this.callbacks.activity("Requested browser state verified");
              return;
            }
            handoff = "MD-1 reported DONE, but code-owned goal evidence is unavailable.";
            break;
          }
          if (history.length >= FAST_LIMITS.actions) { handoff = "Fast action budget exhausted."; break; }
          const attempt: Attempt = { operation: decision.operation, summary: "Attempt issued; delivery not yet confirmed.", outcome: "uncertain" };
          history.push(attempt);
          this.recent.push(attempt);
          if (this.recent.length > FAST_LIMITS.actions) this.recent.shift();
          const stepId = crypto.randomUUID();
          const started = Date.now();
          const label = `MD-1: ${decision.operation}${decision.operation === "CLICK" ? ` "${snapshot.targets.find((target) => target.id === decision.targetId)?.label ?? "unknown target"}"` : ""}`;
          this.callbacks.step(stepId, label);
          let result: FastStepResult;
          try {
            const raw = await withDeadline(chrome.runtime.sendMessage({
              type: "FAST_EXECUTE", command: {
                scope, documentId: snapshot.documentId, snapshotId: snapshot.snapshotId,
                stepId, operation: decision.operation, ...(decision.targetId ? { targetId: decision.targetId } : {}),
              },
            }), 20000, "Fast action result timed out; delivery is uncertain.");
            result = fastStepResultSchema.parse(raw);
          } catch (cause) {
            result = { ok: false, outcome: "uncertain", summary: message(cause).slice(0, 1000) };
          }
          const target = snapshot.targets.find((item) => item.id === decision.targetId);
          Object.assign(attempt, {
            summary: `${decision.operation}${target ? ` "${target.label}" ${target.href ?? ""}` : ""}: ${result.summary}`.slice(0, 1000),
            outcome: result.outcome,
          });
          this.callbacks.step(stepId, label, { ok: result.ok, summary: result.summary }, Date.now() - started);
          this.callbacks.diagnostic({ type: "client.step", attempts: history.length, durationMs: Date.now() - started, outcome: result.outcome });
          if (result.outcome === "uncertain") this.uncertain = true;
          task.signal.throwIfAborted();
          if (!result.ok) { handoff = `${result.outcome}: ${result.summary}`; break; }
        }
        handoff ||= "Fast decision budget exhausted.";
      } catch (cause) {
        task.signal.throwIfAborted();
        handoff = fastDeadline.aborted ? "Fast-run deadline reached." : `Fast path unavailable: ${message(cause)}`;
      } finally {
        signal.removeEventListener("abort", onAbort);
        this.revoke();
      }
    }
    task.signal.throwIfAborted();
    this.callbacks.activity(`Astra handoff: ${handoff}`);
    this.callbacks.diagnostic({ type: "client.handoff", attempts: history.length });
    await this.fallback(task, scope.runId, handoff);
  }

  private async bind(scope: FastScope, signal: AbortSignal) {
    const result = await withDeadline(chrome.runtime.sendMessage({ type: "FAST_BIND", scope }), 16000, "Fast document binding timed out.");
    signal.throwIfAborted();
    if (!isRecord(result) || result.ok !== true) throw new Error(isRecord(result) && typeof result.error === "string" ? result.error : "Fast document binding failed.");
  }

  private async snapshot(scope: FastScope, signal: AbortSignal): Promise<FastSnapshot> {
    const read = async () => fastSnapshotResponseSchema.parse(await withDeadline(
      chrome.runtime.sendMessage({ type: "FAST_SNAPSHOT", scope }), 16000, "Fast observation timed out.",
    ));
    let result = await read();
    signal.throwIfAborted();
    if (!result.ok) {
      // A new document loses content-script state; rebinding a read never replays input.
      await this.bind(scope, signal);
      result = await read();
      signal.throwIfAborted();
    }
    if (!result.ok) throw new Error(result.error);
    this.callbacks.diagnostic({ type: "client.snapshot", snapshotBytes: utf8Bytes(JSON.stringify(result.snapshot)) });
    return result.snapshot;
  }

  private async fallback(task: ClientTaskCandidate, runId: string, reason: string): Promise<void> {
    let actions = 0;
    const readCall: FunctionCall = { type: "function_call", call_id: crypto.randomUUID(), name: "get_page_context", arguments: "{}" };
    const fresh = await this.callbacks.execute(readCall, task.signal, runId);
    actions++;
    const input: ControllerItem[] = [{
      role: "user", content: JSON.stringify({
        taskCandidate: task.userText, transcript: task.transcript, handoff: reason,
        priorAttempts: this.recent, currentPage: compactResult(fresh),
        instruction: "Transcript fragments are not authoritative complete turns. Clarify ambiguous intent; never replay completed or uncertain attempts.",
      }),
    }];
    const seenCalls = new Set<string>();
    for (let round = 1; round <= FAST_LIMITS.astraRounds; round++) {
      task.signal.throwIfAborted();
      if (utf8Bytes(JSON.stringify(input)) > FAST_LIMITS.historyBytes || input.length > 100) throw new Error("Astra continuation budget exhausted.");
      const response = await companionFetch("/api/controller/round", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId, round, input, configuration: this.configuration }),
        signal: task.signal,
      }, 40000);
      if (!response.ok || !response.body) throw new Error(`Astra fallback failed (HTTP ${response.status}).`);
      let completed: Extract<ReturnType<typeof controllerStreamEventSchema.parse>, { type: "completed" }> | undefined;
      for await (const raw of readJsonLines(response.body)) {
        task.signal.throwIfAborted();
        const event = controllerStreamEventSchema.parse(raw);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "text") this.callbacks.text(`${runId}.${event.itemId}`, event.delta, false);
        if (event.type === "completed") {
          if (completed) throw new Error("Duplicate Astra completion event.");
          completed = event;
        }
      }
      if (!completed) throw new Error("Astra stream ended without a complete response.");
      input.push(...completed.output);
      const calls = completed.output.filter((item) => item.type === "function_call");
      if (!calls.length) {
        for (const item of completed.output) {
          if (item.type === "message" && typeof item.id === "string") {
            this.callbacks.text(`${runId}.${item.id}`, completed.text, true);
          }
        }
        this.callbacks.send(this.context.contextAppend(task, completed.text || "Astra returned no public answer. The task outcome is unverified.", "commentary"));
        this.callbacks.activity("Astra response ready");
        return;
      }
      for (const item of calls) {
        task.signal.throwIfAborted();
        if (typeof item.call_id !== "string" || typeof item.name !== "string" || typeof item.arguments !== "string") {
          throw new Error("Astra returned an incomplete function call.");
        }
        if (seenCalls.has(item.call_id)) throw new Error("Astra repeated a function call ID; nothing was replayed.");
        seenCalls.add(item.call_id);
        let result: ActionResult;
        if (actions >= FAST_LIMITS.astraActions) result = { ok: false, summary: "Astra action budget exhausted. Do not issue more browser actions." };
        else if (item.name === "find_and_click") result = { ok: false, summary: "MD-1 re-entry is disabled during Astra fallback." };
        else {
          actions++;
          result = await this.callbacks.execute({
            type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments,
          }, task.signal, runId);
        }
        input.push({ type: "function_call_output", call_id: item.call_id, output: compactResult(result) });
      }
    }
    throw new Error("Astra response-round budget exhausted; task is unverified.");
  }
}

export function verifiedGoal(goal: string, initial: FastSnapshot, current: FastSnapshot, history: Attempt[]): boolean {
  if (current.documentId === initial.documentId && current.url === initial.url) {
    const scroll = /^(?:please )?scroll (up|down)[.!]?$/i.exec(goal.trim());
    if (scroll) {
      const down = scroll[1]!.toLowerCase() === "down";
      return history.some((attempt) => attempt.outcome === "executed" && attempt.operation === (down ? "SCROLL_DOWN" : "SCROLL_UP")) &&
        (down ? current.viewport.y > initial.viewport.y : current.viewport.y < initial.viewport.y);
    }
  }
  if (!history.some((attempt) => attempt.outcome === "executed" && attempt.operation === "CLICK")) return false;
  const normalize = (text: string) => text.trim().toLowerCase().replace(/[.!]+$/, "").replace(/^["']|["']$/g, "");
  const checked = /^(?:please )?(uncheck|check) (?:the )?(.+?)[.!]?$/i.exec(goal.trim());
  if (checked && initial.documentId === current.documentId && initial.url === current.url) {
    const target = current.targets.find((item) => normalize(item.label) === normalize(checked[2]!));
    if (target) {
      const value: unknown = JSON.parse(target.state);
      if (isRecord(value)) return value.checked === (checked[1]!.toLowerCase() === "check") ||
        value.checked === String(checked[1]!.toLowerCase() === "check");
    }
    const expanded = /^(?:please )?(open|expand|collapse|close) (?:the )?(.+?)[.!]?$/i.exec(goal.trim());
    if (expanded && initial.documentId === current.documentId && initial.url === current.url) {
      const target = current.targets.find((item) => normalize(item.label) === normalize(expanded[2]!));
      if (target) {
        const value: unknown = JSON.parse(target.state);
        if (isRecord(value)) {
          const expected = /^(open|expand)$/i.test(expanded[1]!);
          return value.expanded === String(expected) || value.open === expected;
        }
      }
    }
  }
  const url = goal.match(/https?:\/\/[^\s]+/i)?.[0];
  return Boolean(url && current.url !== initial.url && current.url === url &&
    initial.targets.some((target) => target.href === url));
}

async function* readJsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (utf8Bytes(buffer) > FAST_LIMITS.historyBytes) throw new Error("Controller stream event exceeded its byte budget.");
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) {
          let parsed: unknown;
          try { parsed = JSON.parse(line); }
          catch { throw new Error("Controller transport returned malformed JSON."); }
          yield parsed;
        }
      }
      if (done) {
        if (buffer.trim()) throw new Error("Controller stream ended with an incomplete event.");
        break;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

function compactResult(result: ActionResult): string {
  return createToolOutputEvent("client-output", result, MAX_TOOL_EVENT_BYTES).item.output;
}
function fingerprint(snapshot: FastSnapshot) {
  const { snapshotId: _snapshotId, ...state } = snapshot;
  return JSON.stringify(state);
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
