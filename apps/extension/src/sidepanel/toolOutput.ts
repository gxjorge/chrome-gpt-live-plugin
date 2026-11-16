import { pageContextSchema, type ActionResult, type PageContext } from "@chrome-gpt-live/shared";

const encoder = new TextEncoder();
export const MAX_TOOL_EVENT_BYTES = 6000;
// Leave room for service-owned input and framing under the observed 32 KiB limit.
export const MAX_PENDING_TOOL_BYTES = 24000;
export const MAX_PENDING_TOOL_ITEMS = 100;
export const MIN_TOOL_EVENT_BYTES = 700;

export function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let result = "";
  let bytes = 0;
  for (const character of text) {
    const size = utf8Bytes(character);
    if (bytes + size > Math.max(0, maxBytes - 3)) break;
    result += character;
    bytes += size;
  }
  return result + (maxBytes >= 3 ? "..." : "");
}

export function createToolOutputEvent(callId: string, result: ActionResult, maxBytes: number) {
  const eventId = crypto.randomUUID();
  const wrap = (value: ActionResult) => ({
    type: "response.item.create",
    event_id: eventId,
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(value) },
  });
  let event = wrap(result);
  if (utf8Bytes(JSON.stringify(event)) <= maxBytes) return event;

  for (const scale of [1, 0.7, 0.45, 0.25, 0.1]) {
    event = wrap({
      ...result,
      summary: `${truncateUtf8(result.summary, 240)} Details abbreviated to fit the live service's context limit.`,
      data: compactData(result.data, scale),
    });
    if (utf8Bytes(JSON.stringify(event)) <= maxBytes) return event;
  }
  event = wrap({
    ok: result.ok,
    summary: `${truncateUtf8(result.summary, 120)} Details omitted because the live context budget is nearly full. Do not repeat an action solely because details were omitted.`,
    ...(result.requiresConfirmation !== undefined ? { requiresConfirmation: result.requiresConfirmation } : {}),
    ...(result.confirmationId ? { confirmationId: result.confirmationId } : {}),
  });
  if (utf8Bytes(JSON.stringify(event)) > maxBytes) {
    throw new Error("The pending tool results exceed the live service's context limit. Start a new conversation before taking more browser actions.");
  }
  return event;
}

function compactData(data: unknown, scale: number): unknown {
  const page = pageContextSchema.safeParse(data);
  if (page.success) return compactPage(page.data, scale);
  if (typeof data === "object" && data !== null && "page" in data) {
    const nestedPage = pageContextSchema.safeParse(data.page);
    if (nestedPage.success) {
      return {
        ...("tabId" in data ? { tabId: data.tabId } : {}),
        page: compactPage(nestedPage.data, scale),
      };
    }
  }
  return compactValue(data, scale, 0);
}

function compactPage(page: PageContext, scale: number) {
  const count = (maximum: number) => Math.max(1, Math.floor(maximum * scale));
  const text = (value: string, maximum: number) => {
    const limit = Math.max(24, Math.floor(maximum * scale));
    const shortened = truncateUtf8(value, limit);
    // Preserve literal prefixes so quoted snippets still match the actual page.
    return utf8Bytes(value) > limit ? shortened.slice(0, -3) : shortened;
  };
  return {
    url: page.url,
    title: text(page.title, 180),
    description: text(page.description, 240),
    byline: text(page.byline, 80),
    excerpt: text(page.excerpt, 1600),
    headings: page.headings.slice(0, count(6)).map((heading) => ({ level: heading.level, text: text(heading.text, 100) })),
    citations: page.citations.slice(0, count(8)).map((citation) => ({
      id: citation.id,
      text: text(citation.text, 180),
      ...(citation.page ? { page: citation.page } : {}),
    })),
    controls: [...(page.controls ?? [])].sort((left, right) => Number(right.search) - Number(left.search))
      .slice(0, count(10)).map((control) => ({ ...control, label: text(control.label, 80) })),
    links: page.links.slice(0, count(4)).map((link) => ({ href: link.href, text: text(link.text, 80) })),
    ...(page.document ? { document: page.document } : {}),
    capturedAt: page.capturedAt,
    contextNote: "Abbreviated snapshot. Use get_page_context with a focused query for missing information, or highlight with a distinctive phrase to find and show it. Do not repeatedly request the same full page.",
  };
}

function compactValue(value: unknown, scale: number, depth: number): unknown {
  if (typeof value === "string") return truncateUtf8(value, Math.max(32, Math.floor(1200 * scale)));
  if (depth >= 4) return "[nested details omitted]";
  if (Array.isArray(value)) return value.slice(0, Math.max(1, Math.floor(8 * scale))).map((item) => compactValue(item, scale, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, item]) => [key, compactValue(item, scale, depth + 1)]));
  }
  return value;
}
