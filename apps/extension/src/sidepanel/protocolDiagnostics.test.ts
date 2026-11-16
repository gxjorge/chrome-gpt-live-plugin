import { describe, expect, it } from "vitest";
import { ProtocolDiagnostics } from "./protocolDiagnostics";

describe("protocol diagnostics privacy", () => {
  it("retains event metadata without speech, pages, arguments, settings, output content or raw service messages", () => {
    const diagnostics = new ProtocolDiagnostics();
    const privateText = "PRIVATE_SENTINEL_DO_NOT_EXPORT";
    diagnostics.record("received", { type: "session.input_transcript.delta", delta: privateText });
    diagnostics.record("sent", { type: "session.thinking.append", content: privateText });
    diagnostics.record("sent", { type: "response.item.create", item: { call_id: "call-1", output: privateText } }, 5000);
    diagnostics.record("received", { type: "response.event", delegation_id: "delegation-1", event: {
      type: "response.output_item.done", item: { id: "item-1", call_id: "call-1", arguments: privateText },
    } });
    diagnostics.record("received", { type: "error", error: { code: "invalid_request_error", message: `Input size too large: ${privateText}` } });
    const exported = diagnostics.export();
    expect(exported).not.toContain(privateText);
    expect(exported).toContain("call-1");
    expect(exported).toContain("size_limit");
    expect(exported).toContain('"bytes": 5000');
  });

  it("bounds memory and clears the previous session", () => {
    const diagnostics = new ProtocolDiagnostics();
    for (let index = 0; index < 250; index++) diagnostics.record("sent", { type: "response.create", event_id: `event-${index}` });
    expect(JSON.parse(diagnostics.export()).events).toHaveLength(200);
    diagnostics.clear();
    expect(JSON.parse(diagnostics.export()).events).toEqual([]);
  });
});
