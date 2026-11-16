const ignoredTypes = new Set([
  "session.input_transcript.delta", "session.output_transcript.delta",
  "session.output_audio.delta", "session.input_audio.append",
  "response.output_text.delta", "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta", "response.reasoning_text.delta",
]);

export const BUILD_ID = import.meta.env.VITE_BUILD_ID ?? "development";

type Entry = {
  at: string;
  direction: "sent" | "received";
  type: string;
  eventId?: string;
  clientEventId?: string;
  bytes?: number;
  responseId?: string;
  callId?: string;
  itemId?: string;
  delegationId?: string;
  errorCode?: string;
  errorCategory?: string;
  decision?: number;
  attempts?: number;
  durationMs?: number;
  snapshotBytes?: number;
  outcome?: string;
};

export class ProtocolDiagnostics {
  private readonly entries: Entry[] = [];

  clear(): void {
    this.entries.length = 0;
  }

  record(direction: Entry["direction"], event: unknown, bytes?: number): void {
    if (!isRecord(event)) return;
    const nested = event.type === "response.event" && isRecord(event.event) ? event.event : event;
    const type = identifier(nested.type);
    if (!type || ignoredTypes.has(type)) return;
    const entry: Entry = { at: new Date().toISOString(), direction, type };
    if (bytes !== undefined) entry.bytes = bytes;
    for (const key of ["decision", "attempts", "durationMs", "snapshotBytes"] as const) {
      const value = nested[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000) entry[key] = value;
    }
    if (["executed", "rejected", "uncertain"].includes(String(nested.outcome))) entry.outcome = String(nested.outcome);
    const response = isRecord(nested.response) ? nested.response : {};
    const item = isRecord(nested.item) ? nested.item : {};
    const identifiers = {
      eventId: event.event_id,
      clientEventId: event.client_event_id,
      responseId: response.id ?? nested.response_id,
      callId: item.call_id,
      itemId: item.id ?? nested.item_id,
      delegationId: event.delegation_id,
    };
    for (const key of Object.keys(identifiers) as (keyof typeof identifiers)[]) {
      const value = identifier(identifiers[key]);
      if (value) entry[key] = value;
    }
    if (type === "error" || type === "response.failed") {
      const error = isRecord(nested.error) ? nested.error : isRecord(response.error) ? response.error : {};
      const code = identifier(error.code);
      if (code) entry.errorCode = code;
      const message = typeof error.message === "string" ? error.message : "";
      entry.errorCategory = /pending function call outputs/i.test(message) ? "pending_tool_outputs" :
        /token|too long|too large|size|input history|UTF-8 bytes/i.test(message) ? "size_limit" : "service_error";
    }
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.shift();
  }

  export(): string {
    return JSON.stringify({ build: BUILD_ID, note: "Metadata only: no transcripts, page text, URLs, settings, credentials, or tool arguments.", events: this.entries }, null, 2);
  }
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9_.-]{1,200}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
