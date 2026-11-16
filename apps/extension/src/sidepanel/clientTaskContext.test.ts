import { describe, expect, it } from "vitest";
import {
  ClientTaskContext,
  MAX_CLIENT_APPEND_BYTES,
  MAX_CLIENT_CONTEXT_AGE_MS,
  MAX_CLIENT_CONTEXT_BYTES,
  MAX_CLIENT_CONTEXT_FRAGMENTS,
  MAX_CLIENT_EVENT_IDS,
  type ClientContextUpdate,
  type ClientTaskCandidate,
} from "./clientTaskContext";

const user = (id: string, delta: string, start = 100, end = 200) => ({
  type: "session.input_transcript.delta", event_id: id, delta, start_ms: start, end_ms: end,
});

it("preserves whitespace fragments without treating whitespace alone as a task", () => {
  const context = new ClientTaskContext("session-1", 42);
  context.accept(user("first", "Open", 100, 200));
  context.accept(user("space", " ", 200, 210));
  context.accept(user("last", "the menu.", 210, 300));
  expect(candidate(context.accept(delegation())).userText).toBe("Open the menu.");
  const empty = new ClientTaskContext("session-2", 42);
  empty.accept(user("space", " "));
  expect(empty.accept(delegation())).toEqual({ status: "blocked", reason: "missing_user_context" });
});
const assistant = (id: string, delta: string, start = 10, end = 90) => ({
  ...user(id, delta, start, end), type: "session.output_transcript.delta",
});
const delegation = (id = "delegation-1", offset = 1000) => ({
  type: "session.delegation.created", event_id: `event-${id}`, offset_ms: offset,
  delegation: { id, type: "delegation", target: "client" },
});

function candidate(update: ClientContextUpdate): ClientTaskCandidate {
  expect(update.status).toBe("candidate");
  if (update.status !== "candidate") throw new Error("Expected a candidate.");
  return update.candidate;
}

function bound() {
  const context = new ClientTaskContext("session-1", 42);
  context.accept(user("user-1", "Open the menu."));
  return { context, task: candidate(context.accept(delegation())) };
}

describe("client delegation context contract (synthetic fixtures, not a live service check)", () => {
  it("collects a task candidate without an Astra request or an invented turn-done event", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open ", 100, 200));
    context.accept(user("user-2", "the menu.", 200, 300));
    const task = candidate(context.accept(delegation()));
    expect(task).toMatchObject({
      sessionId: "session-1", tabId: 42, delegationId: "delegation-1",
      offsetMs: 1000, userText: "Open the menu.",
    });
    expect(task.transcript).toHaveLength(2);
    expect(context.isCurrent(task)).toBe(true);
  });

  it("retains separate speaker context when delivery interleaves and orders fragments by timeline", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-2", "menu.", 300, 400));
    context.accept(assistant("assistant-1", "Which menu?", 10, 90));
    context.accept(user("user-1", "Open the ", 100, 200));
    const task = candidate(context.accept(delegation()));
    expect(task.userText).toBe("Open the menu.");
    expect(task.transcript.map((fragment) => fragment.speaker)).toEqual(["assistant", "user", "user"]);
  });

  it("does not invent task text from a delegation ID or an assistant fragment", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(assistant("assistant-1", "I will open the menu."));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "missing_user_context" });
  });

  it.each([
    { start_ms: undefined }, { end_ms: undefined }, { start_ms: -1 }, { end_ms: Number.NaN },
    { start_ms: Number.POSITIVE_INFINITY }, { end_ms: 50 }, { start_ms: 1.5 },
    { delta: "" }, { delta: 42 }, { event_id: undefined },
  ])("rejects malformed transcript context: %j", (invalid) => {
    const { context, task } = bound();
    expect(context.accept({ ...user("bad", "Changed task"), ...invalid })).toEqual({
      status: "blocked", reason: "invalid_transcript",
    });
    expect(task.signal.aborted).toBe(true);
  });

  it("cannot silently discard an invalid fragment and bind the remaining partial command", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("valid", "Open the menu."));
    context.accept({ ...user("invalid", "Do not."), start_ms: undefined });
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "unsupported_contract" });
    context.accept(user("later", "Scroll down.", 1200, 1300));
    expect(context.accept(delegation("next", 1400))).toEqual({
      status: "blocked", reason: "unsupported_contract",
    });
  });

  it.each([
    { offset_ms: undefined }, { offset_ms: -1 }, { offset_ms: Number.NaN },
    { delegation: { id: "other", target: "client" } },
    { delegation: { id: "other", type: "delegation", target: "responses" } },
  ])("rejects an unsupported delegation contract: %j", (invalid) => {
    const { context, task } = bound();
    expect(context.accept({ ...delegation("invalid"), ...invalid })).toEqual({
      status: "blocked", reason: "invalid_delegation",
    });
    expect(task.signal.aborted).toBe(true);
  });

  it("treats duplicate transcript and delegation events as idempotent", () => {
    const { context, task } = bound();
    expect(context.accept(user("user-1", "Open the menu."))).toEqual({ status: "ignored" });
    expect(context.accept(delegation())).toEqual({ status: "ignored" });
    expect(context.accept({ ...delegation(), event_id: "redelivered" })).toEqual({ status: "ignored" });
    expect(context.isCurrent(task)).toBe(true);
  });

  it("invalidates a candidate on new user speech without waiting for a later delegation", () => {
    const { context, task } = bound();
    context.accept(user("user-2", "Actually, stop.", 1100, 1200));
    expect(task.signal.aborted).toBe(true);
    expect(context.isCurrent(task)).toBe(false);
  });

  it("invalidates a candidate when an earlier user fragment arrives late", () => {
    const { context, task } = bound();
    context.accept(user("late", "but do not click", 300, 400));
    expect(context.isCurrent(task)).toBe(false);
    expect(context.accept(delegation())).toEqual({ status: "ignored" });
  });

  it("invalidates on late assistant context but not later ordinary assistant speech", () => {
    const { context, task } = bound();
    context.accept(assistant("later", "Working on it.", 1200, 1300));
    expect(context.isCurrent(task)).toBe(true);
    context.accept(assistant("late", "Did you mean settings?", 10, 90));
    expect(context.isCurrent(task)).toBe(false);
  });

  it("blocks overlapping speech instead of treating fragments as semantic turns", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open the menu.", 100, 400));
    context.accept(assistant("assistant-1", "Which menu?", 200, 300));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "overlapping_speech" });
  });

  it("blocks overlapping same-speaker fragments whose ordering is ambiguous", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open ", 100, 300));
    context.accept(user("user-2", "the menu.", 200, 400));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "overlapping_speech" });
  });

  it("blocks work when a user fragment extends beyond the delegation's offset", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open the menu, but", 100, 1200));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "future_context" });
  });

  it("does not clip an assistant fragment that crosses the delegation offset into completed context", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open the menu."));
    context.accept(assistant("assistant-1", "Are you sure?", 900, 1100));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "future_context" });
  });

  it("rejects a new user fragment that straddles the previous delegation boundary", () => {
    const { context, task } = bound();
    context.accept(user("straddling", "Actually, do not.", 900, 1100));
    expect(context.accept(delegation("next", 1200))).toEqual({ status: "blocked", reason: "ambiguous_boundary" });
    expect(task.signal.aborted).toBe(true);
  });

  it("does not reuse an earlier user request for another delegation", () => {
    const { context, task } = bound();
    expect(context.accept(delegation("delegation-2", 1100))).toEqual({
      status: "blocked", reason: "missing_user_context",
    });
    expect(context.isCurrent(task)).toBe(false);
  });

  it("binds a later request to a new revision and cancels the previous task", () => {
    const { context, task } = bound();
    context.accept(user("user-2", "Scroll down.", 1200, 1300));
    const next = candidate(context.accept(delegation("delegation-2", 1400)));
    expect(next.userText).toBe("Scroll down.");
    expect(next.revision).toBeGreaterThan(task.revision);
    expect(task.signal.aborted).toBe(true);
    expect(context.isCurrent(next)).toBe(true);
  });

  it("rejects a delegation whose offset moves backwards", () => {
    const { context, task } = bound();
    expect(context.accept(delegation("older", 900))).toEqual({
      status: "blocked", reason: "reused_delegation",
    });
    expect(task.signal.aborted).toBe(true);
  });

  it("bounds age without pretending that elapsed silence proves a complete command", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("user-1", "Open the menu."));
    candidate(context.accept(delegation("at-limit", 200 + MAX_CLIENT_CONTEXT_AGE_MS)));
    const expired = new ClientTaskContext("session-2", 42);
    expired.accept(user("user-1", "Open the menu."));
    expect(expired.accept(delegation("too-old", 201 + MAX_CLIENT_CONTEXT_AGE_MS))).toEqual({
      status: "blocked", reason: "stale_user_context",
    });
  });

  it("rejects truncated task context at the exact byte boundary", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("at-limit", "x".repeat(MAX_CLIENT_CONTEXT_BYTES)));
    candidate(context.accept(delegation()));
    const oversized = new ClientTaskContext("session-2", 42);
    oversized.accept(user("over-limit", "x".repeat(MAX_CLIENT_CONTEXT_BYTES + 1)));
    expect(oversized.accept(delegation())).toEqual({ status: "blocked", reason: "context_truncated" });
  });

  it("counts multibyte text in bytes, not JavaScript string length", () => {
    const context = new ClientTaskContext("session-1", 42);
    context.accept(user("oversized", "\u6f22".repeat(Math.ceil(MAX_CLIENT_CONTEXT_BYTES / 3))));
    expect(context.accept(delegation())).toEqual({ status: "blocked", reason: "context_truncated" });
  });

  it("rejects truncated task context at the exact fragment boundary", () => {
    const context = new ClientTaskContext("session-1", 42);
    for (let index = 0; index < MAX_CLIENT_CONTEXT_FRAGMENTS; index++) {
      context.accept(user(`user-${index}`, "x", index * 2, index * 2 + 1));
    }
    expect(candidate(context.accept(delegation())).transcript).toHaveLength(MAX_CLIENT_CONTEXT_FRAGMENTS);
    const oversized = new ClientTaskContext("session-2", 42);
    for (let index = 0; index <= MAX_CLIENT_CONTEXT_FRAGMENTS; index++) {
      oversized.accept(user(`user-${index}`, "x", index * 2, index * 2 + 1));
    }
    expect(oversized.accept(delegation())).toEqual({ status: "blocked", reason: "context_truncated" });
  });

  it("does not replay an old delegation after its event-ID deduplication entry is evicted", () => {
    const { context, task } = bound();
    for (let index = 0; index <= MAX_CLIENT_EVENT_IDS; index++) {
      context.accept(assistant(`assistant-${index}`, "x", 1200 + index * 2, 1201 + index * 2));
    }
    expect(context.accept(delegation("old", 900))).toEqual({ status: "blocked", reason: "reused_delegation" });
    expect(context.isCurrent(task)).toBe(false);
  });

  it("Stop invalidates current results but permits a later, fresh task", () => {
    const { context, task } = bound();
    expect(context.cancel()).toEqual({ status: "cancelled" });
    expect(context.isCurrent(task)).toBe(false);
    expect(() => context.contextAppend(task, "Stale result")).toThrow("invalidated");
    context.accept(user("user-2", "Scroll down.", 1100, 1200));
    expect(context.isCurrent(candidate(context.accept(delegation("next", 1300))))).toBe(true);
  });

  it("session closure clears context and rejects subsequent task events", () => {
    const { context, task } = bound();
    context.close();
    expect(task.signal.aborted).toBe(true);
    expect(context.accept(user("later", "Open settings."))).toEqual({ status: "blocked", reason: "session_closed" });
    expect(context.accept(delegation("later", 1500))).toEqual({ status: "blocked", reason: "session_closed" });
  });

  it.each(["session.closed", "error"])("invalidates task context on the %s service event", (type) => {
    const { context, task } = bound();
    expect(context.accept({ type })).toEqual({ status: "cancelled" });
    expect(task.signal.aborted).toBe(true);
    expect(context.accept(delegation("later", 1500))).toEqual({ status: "blocked", reason: "session_closed" });
  });

  it("correlates bounded context appends without treating acknowledgments as action completion", () => {
    const { context, task } = bound();
    const append = context.contextAppend(task, "\u6f22".repeat(1000));
    expect(append).toMatchObject({ type: "session.thinking.append", delegation_id: "delegation-1" });
    expect(new TextEncoder().encode(append.content).byteLength).toBeLessThanOrEqual(MAX_CLIENT_APPEND_BYTES);
    expect(context.accept({
      type: "session.thinking.appended", client_event_id: append.event_id, start_ms: 1100, end_ms: 1200,
    })).toEqual({ status: "ignored" });
    expect(context.contextAppend(task, "Observed result.", "commentary").type).toBe("session.commentary.append");
    expect(() => context.contextAppend(task, " ")).toThrow("empty");
    expect(context.isCurrent(task)).toBe(true);
  });

  it("does not share task identity across sessions or exact conversation tabs", () => {
    const { task } = bound();
    const anotherSession = new ClientTaskContext("session-2", 42);
    const anotherTab = new ClientTaskContext("session-1", 43);
    expect(anotherSession.isCurrent(task)).toBe(false);
    expect(anotherTab.isCurrent(task)).toBe(false);
  });
});
