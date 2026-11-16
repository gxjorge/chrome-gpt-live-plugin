import { describe, expect, it } from "vitest";
import type { PageContext } from "@chrome-gpt-live/shared";
import { createToolOutputEvent, MAX_TOOL_EVENT_BYTES, truncateUtf8, utf8Bytes } from "./toolOutput";

const page: PageContext = {
  url: "https://example.com/article", title: "A large page", description: "", byline: "",
  excerpt: "\u6f22\u5b57 \"quoted\" \n".repeat(2000),
  headings: [{ level: 1, text: "Large page" }],
  citations: Array.from({ length: 40 }, (_, index) => ({ id: `passage-${index}`, text: `Evidence ${index}: ${"Important facts. ".repeat(40)}` })),
  controls: Array.from({ length: 60 }, (_, index) => ({
    selector: `[data-chrome-gpt-live-control="control-${index}"]`, label: `Control ${index} ${"Label ".repeat(30)}`,
    kind: "text", search: index === 59, blocked: false,
  })),
  links: Array.from({ length: 80 }, (_, index) => ({ text: `Link ${index}`, href: `https://example.com/${index}?value=${"long-value".repeat(60)}` })),
  capturedAt: "2026-09-23T00:00:00Z",
};

describe("bounded native tool outputs", () => {
  it("measures the complete UTF-8 envelope, including escaped JSON, instead of counting characters", () => {
    const result = { ok: true, summary: "Read the page.", data: page };
    expect(utf8Bytes(JSON.stringify(result))).toBeGreaterThan(32768);
    const event = createToolOutputEvent("call-1", result, MAX_TOOL_EVENT_BYTES);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(MAX_TOOL_EVENT_BYTES);
    const output = JSON.parse(event.item.output);
    expect(output.ok).toBe(true);
    expect(output.data.contextNote).toContain("Abbreviated");
    expect(output.data.controls[0].search).toBe(true);
    expect(output.data.controls[0].selector).toBe(page.controls![59]!.selector);
    for (const citation of output.data.citations) {
      expect(page.citations.find((original) => original.id === citation.id)?.text.startsWith(citation.text)).toBe(true);
    }
    for (const link of output.data.links) expect(page.links.some((original) => original.href === link.href)).toBe(true);
  });

  it("preserves navigation tab identity and compacts nested page context", () => {
    const event = createToolOutputEvent("navigate-1", { ok: true, summary: "Opened page.", data: { tabId: 42, page } }, 3000);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(3000);
    expect(JSON.parse(event.item.output)).toMatchObject({ ok: true, data: { tabId: 42, page: { url: page.url } } });
  });

  it("keeps PDF page numbers and document details when compacting", () => {
    const pdf: PageContext = {
      ...page,
      url: "file:///C:/Docs/report.pdf",
      controls: [],
      citations: page.citations.map((citation, index) => ({ ...citation, id: `pdf-p${index + 1}-1`, page: index + 1 })),
      document: { type: "pdf", pageCount: 40, truncated: false },
    };
    const output = JSON.parse(createToolOutputEvent("read-1", { ok: true, summary: "Read the page.", data: pdf }, MAX_TOOL_EVENT_BYTES).item.output);
    expect(output.data.document).toEqual({ type: "pdf", pageCount: 40, truncated: false });
    expect(output.data.citations[1]).toMatchObject({ id: "pdf-p2-1", page: 2 });
  });

  it("preserves failure and confirmation semantics when details must be shortened", () => {
    const event = createToolOutputEvent("confirm-1", {
      ok: false, summary: "Confirmation required.", requiresConfirmation: true, confirmationId: "confirmation-1",
      data: { analysis: "Private page text ".repeat(5000) },
    }, 1000);
    expect(utf8Bytes(JSON.stringify(event))).toBeLessThanOrEqual(1000);
    expect(JSON.parse(event.item.output)).toMatchObject({ ok: false, requiresConfirmation: true, confirmationId: "confirmation-1" });
  });

  it("leaves small results unchanged and truncates only at Unicode character boundaries", () => {
    const result = { ok: true, summary: "Done." };
    expect(createToolOutputEvent("call-1", result, 1000).item.output).toBe(JSON.stringify(result));
    const text = truncateUtf8("\u{1f642}".repeat(100), 33);
    expect(utf8Bytes(text)).toBeLessThanOrEqual(33);
    expect(text).not.toContain("\ufffd");
  });
});
