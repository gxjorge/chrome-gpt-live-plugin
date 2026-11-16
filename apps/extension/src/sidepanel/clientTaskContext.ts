import { truncateUtf8, utf8Bytes } from "./toolOutput";

export const MAX_CLIENT_CONTEXT_FRAGMENTS = 128;
export const MAX_CLIENT_CONTEXT_BYTES = 8000;
export const MAX_CLIENT_EVENT_IDS = 256;
export const MAX_CLIENT_CONTEXT_AGE_MS = 10000;
export const MAX_CLIENT_APPEND_BYTES = 480;

type Speaker = "user" | "assistant";

export type TimedTranscript = Readonly<{
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
}>;

// A candidate is conversation context, not a completed command or permission to act.
export type ClientTaskCandidate = Readonly<{
  sessionId: string;
  tabId: number;
  delegationId: string;
  revision: number;
  offsetMs: number;
  userText: string;
  transcript: readonly TimedTranscript[];
  signal: AbortSignal;
}>;

type BlockReason =
  | "invalid_transcript"
  | "invalid_delegation"
  | "context_truncated"
  | "missing_user_context"
  | "future_context"
  | "ambiguous_boundary"
  | "overlapping_speech"
  | "stale_user_context"
  | "reused_delegation"
  | "unsupported_contract"
  | "session_closed";

export type ClientContextUpdate =
  | { status: "ignored" }
  | { status: "transcript"; speaker: Speaker }
  | { status: "candidate"; candidate: ClientTaskCandidate }
  | { status: "blocked"; reason: BlockReason }
  | { status: "cancelled" };

export class ClientTaskContext {
  private readonly fragments: TimedTranscript[] = [];
  private readonly seenEventIds = new Set<string>();
  private readonly seenDelegations = new Set<string>();
  private retainedBytes = 0;
  private discardedThroughMs = -1;
  private lastDelegationOffset = -1;
  private revision = 0;
  private active: { candidate: ClientTaskCandidate; controller: AbortController } | undefined;
  private contractInvalid = false;
  private closed = false;

  constructor(private readonly sessionId: string, private readonly tabId: number) {
    if (!identifier(sessionId) || !Number.isSafeInteger(tabId) || tabId < 0) {
      throw new Error("Client task context requires a session ID and an exact tab ID.");
    }
  }

  accept(event: unknown): ClientContextUpdate {
    if (!isRecord(event)) return { status: "ignored" };
    if (event.type === "session.closed" || event.type === "error") {
      this.close();
      return { status: "cancelled" };
    }
    const user = event.type === "session.input_transcript.delta";
    const assistant = event.type === "session.output_transcript.delta";
    const delegation = event.type === "session.delegation.created";
    if (!user && !assistant && !delegation) return { status: "ignored" };
    if (this.closed) return { status: "blocked", reason: "session_closed" };
    if (this.contractInvalid) return { status: "blocked", reason: "unsupported_contract" };
    if (!identifier(event.event_id)) return this.block(user || assistant ? "invalid_transcript" : "invalid_delegation");
    if (this.seenEventIds.has(event.event_id)) return { status: "ignored" };
    remember(this.seenEventIds, event.event_id);
    if (delegation) return this.bind(event);

    const speaker: Speaker = user ? "user" : "assistant";
    if (typeof event.delta !== "string" || !event.delta.length ||
      !timestamp(event.start_ms) || !timestamp(event.end_ms) || event.end_ms < event.start_ms) {
      return this.block("invalid_transcript");
    }
    if (event.start_ms <= this.discardedThroughMs) return this.block("context_truncated");
    if (user || (this.active && event.start_ms <= this.active.candidate.offsetMs)) this.invalidate();
    const fragment: TimedTranscript = Object.freeze({
      speaker, text: event.delta, startMs: event.start_ms, endMs: event.end_ms,
    });
    this.fragments.push(fragment);
    this.fragments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    this.retainedBytes += utf8Bytes(fragment.text);
    while (this.fragments.length > MAX_CLIENT_CONTEXT_FRAGMENTS || this.retainedBytes > MAX_CLIENT_CONTEXT_BYTES) {
      const removed = this.fragments.shift()!;
      this.retainedBytes -= utf8Bytes(removed.text);
      this.discardedThroughMs = Math.max(this.discardedThroughMs, removed.endMs);
    }
    return { status: "transcript", speaker };
  }

  isCurrent(candidate: ClientTaskCandidate): boolean {
    return !this.closed && this.active?.candidate === candidate && !candidate.signal.aborted;
  }

  cancel(): ClientContextUpdate {
    this.invalidate();
    return { status: "cancelled" };
  }

  close(): void {
    this.closed = true;
    this.invalidate();
    this.fragments.length = 0;
    this.retainedBytes = 0;
    this.seenEventIds.clear();
    this.seenDelegations.clear();
  }

  contextAppend(candidate: ClientTaskCandidate, content: string, kind: "thinking" | "commentary" = "thinking") {
    if (!this.isCurrent(candidate)) throw new Error("Cannot append a result for an invalidated client task.");
    if (!content.trim()) throw new Error("Client task context cannot be empty.");
    return {
      type: `session.${kind}.append`,
      event_id: crypto.randomUUID(),
      delegation_id: candidate.delegationId,
      content: truncateUtf8(content, MAX_CLIENT_APPEND_BYTES),
    };
  }

  private bind(event: Record<string, unknown>): ClientContextUpdate {
    const delegation = event.delegation;
    if (!isRecord(delegation) || delegation.target !== "client" || delegation.type !== "delegation" ||
      !identifier(delegation.id) || !timestamp(event.offset_ms)) {
      return this.block("invalid_delegation");
    }
    if (this.seenDelegations.has(delegation.id)) return { status: "ignored" };
    const offsetMs = event.offset_ms;
    remember(this.seenDelegations, delegation.id);
    this.invalidate();
    const previousOffset = this.lastDelegationOffset;
    if (offsetMs <= previousOffset) return this.block("reused_delegation");
    this.lastDelegationOffset = offsetMs;
    if (this.discardedThroughMs > previousOffset) return this.block("context_truncated");

    const transcript = this.fragments.filter((fragment) =>
      fragment.endMs > previousOffset && fragment.startMs <= offsetMs);
    const userFragments = transcript.filter((fragment) => fragment.speaker === "user");
    if (!userFragments.length || !userFragments.some((fragment) => fragment.text.trim())) {
      return this.block("missing_user_context");
    }
    if (this.fragments.some((fragment) => fragment.speaker === "user" && fragment.endMs > offsetMs) ||
      transcript.some((fragment) => fragment.endMs > offsetMs)) {
      return this.block("future_context");
    }
    if (transcript.some((fragment) => fragment.startMs < previousOffset)) {
      return this.block("ambiguous_boundary");
    }
    if (transcript.some((fragment, index) =>
      transcript.slice(index + 1).some((other) => other.startMs < fragment.endMs))) {
      return this.block("overlapping_speech");
    }
    const latestUser = userFragments.at(-1)!;
    if (offsetMs - latestUser.endMs > MAX_CLIENT_CONTEXT_AGE_MS) return this.block("stale_user_context");
    const controller = new AbortController();
    const candidate: ClientTaskCandidate = Object.freeze({
      sessionId: this.sessionId,
      tabId: this.tabId,
      delegationId: delegation.id,
      revision: this.revision,
      offsetMs,
      userText: userFragments.map((fragment) => fragment.text).join(""),
      transcript: Object.freeze(transcript),
      signal: controller.signal,
    });
    this.active = { candidate, controller };
    return { status: "candidate", candidate };
  }

  private block(reason: BlockReason): ClientContextUpdate {
    if (reason === "invalid_transcript" || reason === "invalid_delegation") this.contractInvalid = true;
    this.invalidate();
    return { status: "blocked", reason };
  }

  private invalidate(): void {
    this.active?.controller.abort(new Error("Client task context was cancelled or changed."));
    this.active = undefined;
    this.revision++;
  }
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,200}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remember(ids: Set<string>, id: string): void {
  ids.add(id);
  if (ids.size > MAX_CLIENT_EVENT_IDS) ids.delete(ids.values().next().value!);
}
