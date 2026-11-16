import {
  browserActionSchema,
  actionResultSchema,
  clickTargetDecisionResponseSchema,
  pageContextSchema,
  liveSessionResponseSchema,
  type ActionResult,
  type BrowserAction,
  type ClickTarget,
  type ClickTargetDecision,
  type PageContext,
  type FoundryConfiguration,
} from "@chrome-gpt-live/shared";
import type { ClickTargetsResponse } from "../messages";
import { captureMicrophone } from "../microphone";
import { ResponsesToolLoop, type FunctionCall } from "./responsesToolLoop";
import { actionLabel, withDeadline, type ActivityUpdate } from "./activity";
import { companionFetch } from "./companion";
import { ProtocolDiagnostics } from "./protocolDiagnostics";
import { truncateUtf8 } from "./toolOutput";
import { ClientDelegation } from "./clientDelegation";

type LiveSessionCallbacks = {
  onStatus: (status: string) => void;
  onTranscript: (speaker: "user" | "assistant", delta: string) => void;
  onAction: (action: BrowserAction, result: ActionResult, callId: string, durationMs: number) => void;
  onActionStart: (action: BrowserAction, callId: string) => void;
  onActivity: (activity: ActivityUpdate) => void;
  onControllerText: (itemId: string, text: string, done: boolean) => void;
  onPageChanged: (page: PageContext | undefined) => void;
  onError: (message: string) => void;
  onTabChanged: (tabId: number) => void;
  onTaskState?: (busy: boolean) => void;
  onTaskStep?: (id: string, label: string, result?: ActionResult, durationMs?: number) => void;
  onConfirmation: (
    action: BrowserAction,
    result: ActionResult,
    complete: (confirmed: boolean) => Promise<void>,
  ) => void;
};

export class LiveSession {
  private readonly callbacks: LiveSessionCallbacks;
  private peer: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private audio?: HTMLAudioElement;
  private stream?: MediaStream;
  private tabId?: number;
  private page: PageContext | undefined;
  private toolLoop?: ResponsesToolLoop;
  private configuration: FoundryConfiguration | undefined;
  private readonly decidedTargets = new WeakMap<BrowserAction, { target: ClickTarget; fromUrl: string; confidence: number }>();
  private readonly diagnostics = new ProtocolDiagnostics();
  private failureReported = false;
  private client: ClientDelegation | undefined;
  private readonly confirmationProofs = new WeakMap<BrowserAction, string>();

  constructor(callbacks: LiveSessionCallbacks) {
    this.callbacks = callbacks;
  }

  async start(tabId: number, page?: PageContext, configuration?: FoundryConfiguration): Promise<void> {
    this.failureReported = false;
    this.diagnostics.clear();
    this.tabId = tabId;
    this.page = page;
    this.configuration = configuration ? { ...configuration } : undefined;
    this.callbacks.onStatus("Requesting microphone");
    this.callbacks.onActivity({ phase: "connecting", label: "Opening the microphone" });

    this.stream = await captureMicrophone();
    this.callbacks.onStatus("Connecting");
    this.callbacks.onActivity({ phase: "connecting", label: "Connecting GPT Live and Astra" });

    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.stream.getTracks().forEach((track) => peer.addTrack(track, this.stream!));
    peer.addTransceiver("audio", { direction: "sendrecv" });

    this.audio = new Audio();
    this.audio.autoplay = true;
    peer.addEventListener("track", (event) => {
      if (this.peer !== peer) {
        return;
      }
      this.audio!.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio!.play();
    });

    const channel = peer.createDataChannel("oai-events");
    this.channel = channel;
    const toolLoop = new ResponsesToolLoop({
      execute: (call, signal) => this.handleFunctionCall(call, signal),
      send: (event) => {
        if (channel.readyState !== "open") {
          throw new Error("The GPT-Live data channel closed before tool results could be submitted.");
        }
        const raw = JSON.stringify(event);
        this.diagnostics.record("sent", event, new TextEncoder().encode(raw).byteLength);
        channel.send(raw);
        if ("type" in event && event.type === "response.create") {
          this.callbacks.onActivity({ phase: "thinking", label: "Astra is reviewing the results" });
        }
      },
      onError: (message) => this.toolLoop?.stopped ? this.failSession(message) : this.callbacks.onError(message),
    });
    this.toolLoop = toolLoop;
    channel.addEventListener("open", () => {
      if (this.channel !== channel) {
        return;
      }
      this.callbacks.onStatus("Live");
      this.callbacks.onActivity({ phase: "idle", label: "Listening. Ask about the page or tell me where to browse." });
      this.appendPageContext(page);
    });
    channel.addEventListener("message", (event) => {
      if (this.channel === channel) {
        this.handleEvent(String(event.data));
      }
    });
    channel.addEventListener("close", () => {
      toolLoop.stop();
      if (this.channel === channel) {
        this.failSession("The voice connection closed.");
      }
    });
    channel.addEventListener("error", () => {
      toolLoop.stop();
      if (this.channel === channel) {
        this.failSession("The GPT-Live data channel failed.");
      }
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.peer === peer && peer.connectionState === "failed") {
        this.failSession("The voice connection failed.");
      }
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await companionFetch("/api/live/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sdp: offer.sdp, page, configuration: this.configuration }),
    }, 60000);
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Could not create GPT-Live session: ${detail}`);
    }
    const answer = liveSessionResponseSchema.parse(await response.json());
    if (answer.controllerMode === "md1-first") {
      this.client = new ClientDelegation(answer.sessionId, tabId, this.configuration, {
        execute: (call, signal, preventReplayRunId) => this.handleFunctionCall(call, signal, preventReplayRunId),
        send: (event) => this.send(event),
        step: (id, label, result, duration) => this.callbacks.onTaskStep?.(id, label, result, duration),
        activity: (label) => this.callbacks.onActivity({ phase: "thinking", label }),
        text: (id, text, done) => this.callbacks.onControllerText(id, text, done),
        busy: (busy) => this.callbacks.onTaskState?.(busy),
        error: (message) => this.callbacks.onError(message),
        diagnostic: (event) => this.diagnostics.record("received", event),
        currentTab: () => this.tabId,
      });
    }
    await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = undefined;
    this.callbacks.onTaskState?.(false);
    this.toolLoop?.stop();
    if (this.channel?.readyState === "open") {
      try {
        this.send({ type: "session.close", event_id: crypto.randomUUID() });
      } catch {
        this.callbacks.onError("The connection could not be closed remotely. Local microphone capture has been stopped.");
      }
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    const channel = this.channel;
    const peer = this.peer;
    this.channel = undefined;
    this.peer = undefined;
    channel?.close();
    peer?.close();
    if (this.audio) {
      this.audio.srcObject = null;
    }
    this.callbacks.onStatus("Ready");
    this.callbacks.onActivity({ phase: "idle", label: "Conversation ended" });
  }

  exportDiagnostics(): string {
    return this.diagnostics.export();
  }

  stopTask(): void {
    this.client?.stop();
    this.send({ type: "session.thinking.append", event_id: crypto.randomUUID(), delegation_id: null,
      content: "The user stopped browser work. Do not repeat the cancelled task. Voice conversation can continue." });
  }

  updatePage(page: PageContext | undefined, notifyLive = true): void {
    this.page = page;
    this.callbacks.onPageChanged(page);
    if (notifyLive && this.channel?.readyState === "open") {
      this.appendPageContext(page);
    }
  }

  private appendPageContext(page: PageContext | undefined): void {
    const context = page ? [
      `Current page: ${page.title}`,
      `URL: ${page.url}`,
      page.document?.type === "pdf" && `Document: PDF, ${page.document.pageCount} pages. Cite page numbers.`,
      page.description && `Description: ${page.description}`,
      `Passages available by citation ID: ${page.citations.slice(0, 8).map((item) => `${item.id}: ${item.text.slice(0, 100)}`).join(" | ")}`,
    ].filter(Boolean).join("\n").slice(0, 1800)
      : "The conversation tab is a new or blank Chrome tab. No website is open and no page content is available. Converse normally; use navigate or open_tab when the user asks to browse. Do not try to click or type into Chrome's new-tab UI.";
    // UTF-8 bytes bound token count even for non-English text; appends allow 500 tokens.
    const content = truncateUtf8(context, 480);
    this.send({
      type: "session.thinking.append",
      event_id: crypto.randomUUID(),
      delegation_id: null,
      content,
    });
  }

  private handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = String(event.type ?? "");
    this.diagnostics.record("received", event, new TextEncoder().encode(raw).byteLength);
    this.client?.handle(event);
    if (this.client && type === "response.event") {
      this.client.stop();
      this.callbacks.onError("The service returned managed Responses events in client mode. Browser work is stopped; verify the deployed delegation contract.");
      return;
    }
    if (type === "session.input_transcript.delta") {
      this.callbacks.onTranscript("user", String(event.delta ?? ""));
      return;
    }
    if (type === "session.output_transcript.delta") {
      this.callbacks.onTranscript("assistant", String(event.delta ?? ""));
      return;
    }
    if (type === "error") {
      const error = event.error as { message?: string } | undefined;
      this.failSession(error?.message ?? "GPT-Live returned an error.");
      return;
    }
    if (type === "session.delegation.created") {
      this.callbacks.onActivity({ phase: "thinking", label: "Astra is working on your request" });
    }
    if (type === "response.event") {
      this.toolLoop?.handleEvent(event);
      const nested = event.event;
      if (typeof nested !== "object" || nested === null) {
        return;
      }
      if ("type" in nested) {
        if (nested.type === "response.created" || nested.type === "response.in_progress") {
          this.callbacks.onActivity({ phase: "thinking", label: "Astra is working on your request" });
        }
        if ((nested.type === "response.output_text.delta" || nested.type === "response.output_text.done") &&
          "item_id" in nested && typeof nested.item_id === "string") {
          const done = nested.type === "response.output_text.done";
          const text = done && "text" in nested ? nested.text : "delta" in nested ? nested.delta : undefined;
          if (typeof text === "string") {
            this.callbacks.onControllerText(nested.item_id, text, done);
            this.callbacks.onActivity({ phase: "answering", label: "Astra's answer is arriving below" });
          }
        }
        if (nested.type === "response.completed" && !this.toolLoop?.busy) {
          this.callbacks.onActivity({ phase: "idle", label: "Answer ready. Keep the conversation going." });
        }
      }
    }
    if (type === "session.closed") {
      this.failSession("The live session ended.");
    }
  }

  private async handleFunctionCall(call: FunctionCall, signal: AbortSignal, preventReplayRunId?: string): Promise<ActionResult> {
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(call.arguments || "{}");
    } catch {
      return {
        ok: false,
        summary: "The controller returned invalid tool arguments.",
      };
    }

    const parsed = browserActionSchema.safeParse({
      name: call.name,
      arguments: parsedArguments,
    });
    if (!parsed.success) {
      return {
        ok: false,
        summary: parsed.error.message,
      };
    }

    const action = parsed.data;
    const started = Date.now();
    this.callbacks.onActionStart(action, call.call_id);
    this.callbacks.onActivity({ phase: "acting", label: actionLabel(action) });
    const result = await this.executeSafely(action, false, signal, preventReplayRunId);
    if (signal.aborted) {
      return { ok: false, summary: "The session ended before the tool result was returned." };
    }
    this.callbacks.onAction(action, result, call.call_id, Date.now() - started);
    if (result.requiresConfirmation) {
      if (result.confirmationId) this.confirmationProofs.set(action, result.confirmationId);
      this.callbacks.onActivity({ phase: "confirming", label: "Waiting for your confirmation" });
      return new Promise<ActionResult>((resolve) => {
        let settled = false;
        let confirming = false;
        const finish = (value: ActionResult) => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve(value);
        };
        const cancel = () => finish({ ok: false, summary: "The session ended before confirmation." });
        signal.addEventListener("abort", cancel, { once: true });
        this.callbacks.onConfirmation(action, result, async (confirmed) => {
          if (settled || confirming || signal.aborted) {
            return;
          }
          confirming = true;
          if (confirmed) {
            this.callbacks.onActivity({ phase: "acting", label: actionLabel(action) });
          }
          const finalResult = confirmed
            ? await this.executeSafely(action, true, signal, preventReplayRunId)
            : { ok: false, summary: "The user declined the irreversible action." };
          if (!signal.aborted) {
            this.callbacks.onAction(action, finalResult, call.call_id, Date.now() - started);
          }
          finish(finalResult);
        });
      });
    }

    return result;
  }

  private async executeSafely(action: BrowserAction, confirmed: boolean, signal: AbortSignal, preventReplayRunId?: string): Promise<ActionResult> {
    const operation = new AbortController();
    try {
      return await withDeadline(
        this.execute(action, confirmed, AbortSignal.any([signal, operation.signal]), preventReplayRunId),
        action.name === "inspect_viewport" ? 35000 : 20000,
        "This action timed out. It may still be running in the tab; inspect the page before repeating it.",
      );
    } catch (cause) {
      return {
        ok: false,
        summary: `Could not execute ${action.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    } finally {
      operation.abort();
    }
  }

  private async execute(action: BrowserAction, confirmed: boolean, signal: AbortSignal, preventReplayRunId?: string): Promise<ActionResult> {
    signal.throwIfAborted();
    if (!this.tabId) {
      return { ok: false, summary: "The conversation tab is unavailable." };
    }
    if (action.name === "inspect_viewport") {
      return this.inspectViewport(action.arguments.question, signal);
    }
    if (action.name === "find_and_click") {
      return this.findAndClick(action, confirmed, signal);
    }

    const response = await chrome.runtime.sendMessage({
      type: "EXECUTE_ACTION",
      tabId: this.tabId,
      action,
      confirmed,
      ...(preventReplayRunId ? { preventReplayRunId } : {}),
      ...(this.client ? { requireFreshConfirmation: true, confirmationId: this.confirmationProofs.get(action) } : {}),
    });
    const result = actionResultSchema.parse(response);
    if (signal.aborted) {
      return result;
    }
    if (action.name === "open_tab") {
      const data = result.data as { tabId?: number } | undefined;
      if (data?.tabId) {
        this.tabId = data.tabId;
        this.page = undefined;
        this.callbacks.onTabChanged(data.tabId);
      }
    }
    const data = result.data;
    const contextValue = action.name === "get_page_context"
      ? data
      : typeof data === "object" && data !== null && "page" in data
        ? data.page
        : undefined;
    const context = pageContextSchema.safeParse(contextValue);
    if (contextValue === null) {
      this.updatePage(undefined, false);
    } else if (context.success) {
      this.updatePage(context.data, false);
    }
    return result;
  }

  private async inspectViewport(question: string, signal: AbortSignal): Promise<ActionResult> {
    if (!this.tabId) {
      return { ok: false, summary: "The current page is unavailable." };
    }
    const context = await chrome.runtime.sendMessage({ type: "GET_PAGE_CONTEXT", tabId: this.tabId }) as {
      ok: boolean; page?: unknown; error?: string;
    };
    signal.throwIfAborted();
    if (!context.ok) {
      return { ok: false, summary: context.error ?? "Could not refresh page context before visual inspection." };
    }
    if (context.page === null) {
      this.updatePage(undefined, false);
      return { ok: false, summary: "No website is open to inspect. Continue talking or open a website first." };
    }
    const page = pageContextSchema.parse(context.page);
    this.updatePage(page, false);
    const capture = await chrome.runtime.sendMessage({
      type: "CAPTURE_VIEWPORT",
      tabId: this.tabId,
    }) as { ok: boolean; screenshot?: string; error?: string };
    if (!capture.ok || !capture.screenshot) {
      return { ok: false, summary: capture.error ?? "Could not capture the viewport." };
    }
    const response = await companionFetch("/api/controller/viewport", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        screenshot: capture.screenshot,
        question,
        page,
        configuration: this.configuration,
      }),
      signal,
    }, 30000);
    if (!response.ok) {
      return { ok: false, summary: await response.text() };
    }
    const { analysis } = await response.json() as { analysis: string };
    return { ok: true, summary: "Astra inspected the visible page.", data: { analysis } };
  }

  private async findAndClick(
    action: Extract<BrowserAction, { name: "find_and_click" }>,
    confirmed: boolean,
    signal: AbortSignal,
  ): Promise<ActionResult> {
    const tabId = this.tabId!;
    // A confirmation re-executes the action; reuse the original decision instead of re-asking.
    let chosen = this.decidedTargets.get(action);
    if (!chosen) {
      const listing = await chrome.runtime.sendMessage({ type: "LIST_CLICK_TARGETS", tabId, goal: action.arguments.goal }) as ClickTargetsResponse;
      signal.throwIfAborted();
      if (!listing.ok) {
        return { ok: false, summary: listing.error };
      }
      if (listing.targets.length === 0) {
        return { ok: false, summary: "No visible clickable elements were found. Read page context or scroll before retrying." };
      }
      let decision: ClickTargetDecision;
      try {
        decision = await this.decideClickTarget(action.arguments.goal, listing.page, listing.targets, signal);
      } catch (cause) {
        signal.throwIfAborted();
        return {
          ok: false,
          summary: `MD-1 was unavailable (${cause instanceof Error ? cause.message : String(cause)}); handing off to Astra. Nothing was clicked; choose a candidate and call click with its selector.`,
          data: { candidates: listing.targets.slice(0, 10).map(publicCandidate) },
        };
      }
      const byId = new Map(listing.targets.map((target) => [target.id, target]));
      const target = decision.target ? byId.get(decision.target) : undefined;
      if (!target || !decision.confident) {
        const ranked = decision.ranked.map(({ id, probability }) => byId.get(id) && {
          ...publicCandidate(byId.get(id)!), probability: Math.round(probability * 100) / 100,
        }).filter(Boolean);
        return {
          ok: false,
          summary: `MD-1 was not confident (${Math.round(decision.confidence * 100)}%${target ? "" : ", no clear match"}); handing off to Astra. Nothing was clicked; choose a candidate and call click with its selector, or read page context if none fit.`,
          data: { candidates: ranked.length ? ranked : listing.targets.slice(0, 10).map(publicCandidate) },
        };
      }
      chosen = { target, fromUrl: listing.page.url, confidence: decision.confidence };
      this.decidedTargets.set(action, chosen);
    }

    const { target, fromUrl, confidence } = chosen;
    const click = actionResultSchema.parse(await chrome.runtime.sendMessage({
      type: "EXECUTE_ACTION", tabId, action: { name: "click", arguments: { selector: target.selector } }, confirmed,
    }));
    signal.throwIfAborted();
    const decidedBy = { model: "MD-1", confidence: Math.round(confidence * 100) / 100, target: publicCandidate(target) };
    const chose = `MD-1 chose "${target.label.slice(0, 60)}" (${Math.round(confidence * 100)}%).`;
    if (!click.ok) {
      return { ...click, summary: `${chose} ${click.summary}`, data: { ...(isRecord(click.data) ? click.data : {}), decidedBy } };
    }
    if (target.navigates) {
      const navigation = await chrome.runtime.sendMessage({ type: "AWAIT_NAVIGATION", tabId, fromUrl, timeoutMs: 1000 }) as
        ActionResult & { navigated?: boolean };
      signal.throwIfAborted();
      if (navigation.navigated) {
        const page = isRecord(navigation.data) ? navigation.data.page : undefined;
        const context = pageContextSchema.safeParse(page);
        if (page === null) {
          this.updatePage(undefined, false);
        } else if (context.success) {
          this.updatePage(context.data, false);
        }
        return {
          ok: navigation.ok,
          summary: `${chose} ${click.summary} ${navigation.summary}`,
          data: { decidedBy, ...(context.success ? { page: context.data } : {}) },
        };
      }
    }
    return { ...click, summary: `${chose} ${click.summary}`, data: { decidedBy } };
  }

  private async decideClickTarget(
    goal: string,
    page: { title: string; url: string },
    targets: ClickTarget[],
    signal: AbortSignal,
  ): Promise<ClickTargetDecision> {
    const response = await companionFetch("/api/decision/click-target", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goal,
        page,
        targets: targets.map(({ id, kind, label, href }) => ({ id, kind, label, ...(href ? { href } : {}) })),
        configuration: this.configuration,
      }),
      signal,
    }, 9000);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    return clickTargetDecisionResponseSchema.parse(await response.json());
  }

  private send(event: unknown): void {
    if (this.channel?.readyState === "open") {
      const raw = JSON.stringify(event);
      this.diagnostics.record("sent", event, new TextEncoder().encode(raw).byteLength);
      this.channel.send(raw);
    }
  }

  private failSession(message: string): void {
    if (this.failureReported) return;
    this.failureReported = true;
    void this.stop().then(() => {
      this.callbacks.onStatus("Disconnected");
      this.callbacks.onError(`${message} The conversation has stopped. Activate again to start a new session; inspect the page before repeating any action.`);
    });
  }
}

function publicCandidate({ selector, kind, label, href }: ClickTarget) {
  return { selector, kind, label, ...(href ? { href } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
