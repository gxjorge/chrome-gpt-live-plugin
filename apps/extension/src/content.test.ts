// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let content: typeof import("./content");
let onMessage: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  onMessage = vi.fn();
  vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: onMessage } } });
  content = await import("./content");
});
beforeEach(() => { document.body.innerHTML = ""; });
afterEach(() => vi.restoreAllMocks());

function typeAction(selector = "#query") {
  return { name: "type_text", arguments: { selector, text: "test search", submit: true } } as const;
}

describe("document kind detection", () => {
  it("reports the document content type so the background can route PDFs", () => {
    const listener = onMessage.mock.calls[0]![0] as (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;
    const sendResponse = vi.fn();
    listener({ type: "GET_DOCUMENT_KIND" }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, contentType: document.contentType });
  });

  describe("client-mode confirmation freshness", () => {
    it("rejects a replaced target even when the new node uses the same selector and text", async () => {
      document.body.innerHTML = '<button id="delete">Delete entry</button>';
      const action = { name: "click", arguments: { selector: "#delete" } } as const;
      const pending = await content.executeAction(action, false, undefined, true);
      expect(pending.requiresConfirmation).toBe(true);
      document.querySelector("button")!.outerHTML = '<button id="delete">Delete entry</button>';
      const result = await content.executeAction(action, true, pending.confirmationId, true);
      expect(result).toMatchObject({ ok: false, summary: expect.stringContaining("target changed") });
    });

    it("permits one approval only for the original, unchanged action and target", async () => {
      document.body.innerHTML = '<button id="delete">Delete entry</button>';
      const element = document.querySelector("button")!;
      element.scrollIntoView = vi.fn();
      const click = vi.spyOn(element, "click").mockImplementation(() => {});
      const action = { name: "click", arguments: { selector: "#delete" } } as const;
      const pending = await content.executeAction(action, false, undefined, true);
      expect(await content.executeAction(action, true, pending.confirmationId, true)).toMatchObject({ ok: true });
      expect(await content.executeAction(action, true, pending.confirmationId, true)).toMatchObject({ ok: false });
      expect(click).toHaveBeenCalledOnce();
    });

    it("cannot use confirmation to bypass a payment block", async () => {
      document.body.innerHTML = '<button id="payment">Checkout</button>';
      expect(await content.executeAction({ name: "click", arguments: { selector: "#payment" } }, true, "invented", true))
        .toMatchObject({ ok: false });
    });
  });
});

describe("search form execution", () => {
  it("submits a reversible GET search without a confirmation round trip", async () => {
    document.body.innerHTML = '<form role="search" action="/search"><input id="query" name="q" aria-label="Search"><button>Search</button></form>';
    const form = document.querySelector("form")!;
    const submit = vi.spyOn(form, "requestSubmit").mockImplementation(() => {});
    const result = await content.executeAction(typeAction(), false);
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Submitted");
    expect(submit).toHaveBeenCalledWith(document.querySelector("button"));
    expect(document.querySelector<HTMLInputElement>("#query")!.value).toBe("test search");
  });

  describe("visible passage highlighting", () => {
    beforeEach(() => {
      const rect = new DOMRect(0, 1000, 400, 40);
      vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
        0: rect, length: 1, item: () => rect, [Symbol.iterator]: () => [rect].values(),
      });
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    });

    it("creates citations for ordinary pages and short information without article/main wrappers", () => {
      document.body.innerHTML = "<div><h2>Key findings</h2><p>Revenue grew 12%.</p><p hidden>Do not cite hidden content.</p></div>";
      const citations = content.extractPageContext().citations;
      expect(citations.map((citation) => citation.text)).toEqual(["Key findings", "Revenue grew 12%."]);
    });

    it("keeps passage IDs stable when the page inserts earlier content", () => {
      document.body.innerHTML = "<main><p id='target'>The main point is that checking sources makes reading more reliable.</p></main>";
      const original = content.extractPageContext().citations[0]!;
      document.querySelector("main")!.insertAdjacentHTML("afterbegin", "<p>An inserted announcement.</p>");
      const updated = content.extractPageContext().citations;
      expect(updated.find((citation) => citation.text === original.text)?.id).toBe(original.id);
      expect(new Set(updated.map((citation) => citation.id)).size).toBe(updated.length);
    });

    it("scrolls to the actual passage and keeps the highlight until Escape", async () => {
      document.body.innerHTML = "<main><p id='target'>The main point is that checking sources makes reading more reliable.</p></main>";
      const citation = content.extractPageContext().citations[0]!;
      const result = await content.executeAction({ name: "highlight", arguments: { citationId: citation.id, text: citation.text } }, false);
      const target = document.getElementById("target")!;
      expect(result).toMatchObject({ ok: true, data: { text: citation.text } });
      expect(target.classList.contains("chrome-gpt-live-highlight")).toBe(true);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(target.classList.contains("chrome-gpt-live-highlight")).toBe(false);
    });

    it("falls back from stale citations to exact text across inline markup", async () => {
      document.body.innerHTML = "<div><p id='target'>Checking <strong>sources</strong> makes reading more reliable.</p></div>";
      const result = await content.executeAction({ name: "highlight", arguments: { citationId: "missing", text: "Checking sources makes reading" } }, false);
      expect(result.ok).toBe(true);
      expect(document.getElementById("target")!.classList.contains("chrome-gpt-live-highlight")).toBe(true);
    });

    it("can highlight text beyond the limited citation snapshot and inside generic page blocks", async () => {
      document.body.innerHTML = Array.from({ length: 45 }, (_, index) => `<p>Earlier paragraph ${index}.</p>`).join("") +
        "<div id='target'>A distinctive fact at the end of the page.</div>";
      content.extractPageContext();
      const result = await content.executeAction({ name: "highlight", arguments: { text: "distinctive fact" } }, false);
      expect(result.ok).toBe(true);
      expect(document.getElementById("target")!.classList.contains("chrome-gpt-live-highlight")).toBe(true);
    });

    it("retrieves focused passages beyond the initial snapshot without replaying the entire page", () => {
      document.body.innerHTML = `<main>${Array.from({ length: 45 }, (_, index) => `<p>Background paragraph ${index}.</p>`).join("")}
        <p>The main point is that checking sources improves reliability.</p></main>`;
      const full = content.extractPageContext();
      expect(full.citations.some((citation) => citation.text.includes("main point"))).toBe(false);
      const focused = content.extractPageContext("main point");
      expect(focused.citations[0]?.text).toContain("main point");
      expect(focused.excerpt).toContain("checking sources");
      expect(content.extractPageContext("nonexistent-subject").citations).toEqual([]);
    });

    it("opens collapsed details and preserves the previous highlight when no match is found", async () => {
      document.body.innerHTML = "<details><summary>More</summary><p id='target'>The detailed explanation is here.</p></details>";
      expect((await content.executeAction({ name: "highlight", arguments: { text: "detailed explanation" } }, false)).ok).toBe(true);
      expect(document.querySelector("details")!.open).toBe(true);
      expect((await content.executeAction({ name: "highlight", arguments: { text: "Not on this page" } }, false)).ok).toBe(false);
      expect(document.getElementById("target")!.classList.contains("chrome-gpt-live-highlight")).toBe(true);
    });
  });

  it.each([
    '<form method="post" role="search"><input id="query" type="search"><button>Search</button></form>',
    '<form role="search"><input id="query" type="search"><button formmethod="post">Search</button></form>',
    '<form><input id="query" name="comment"><button>Publish</button></form>',
    '<form role="search" action="/delete"><input id="query" type="search"><button>Search</button></form>',
    '<form role="search"><input id="query" type="search"><input type="password"><button>Search</button></form>',
  ])("preserves confirmation for non-reversible or ambiguous forms: %s", async (markup) => {
    document.body.innerHTML = markup;
    const submit = vi.spyOn(document.querySelector("form")!, "requestSubmit");
    const result = await content.executeAction(typeAction(), false);
    expect(result.requiresConfirmation).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLInputElement>("#query")!.value).toBe("");
  });

  it("does not treat a search field in a payment form as a reversible search", async () => {
    document.body.innerHTML = '<form role="search"><input id="query" type="search"><input autocomplete="cc-number"><button>Search</button></form>';
    const result = await content.executeAction(typeAction(), false);
    expect(result.requiresConfirmation).toBe(true);
    const payment = await content.executeAction(typeAction('input[autocomplete="cc-number"]'), true);
    expect(payment.ok).toBe(false);
    expect(payment.summary).toContain("blocked");
  });

  it("reports a missing form instead of claiming a search was submitted", async () => {
    document.body.innerHTML = '<input id="query" type="search"><button>Search</button>';
    const result = await content.executeAction(typeAction(), true);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("no form");
  });

  it("reports validation failure instead of claiming success", async () => {
    document.body.innerHTML = '<form role="search"><input id="query" type="search"><input required><button>Search</button></form>';
    const result = await content.executeAction(typeAction(), false);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("validation failed");
  });

  it("returns stable control selectors without including field values", () => {
    document.body.innerHTML = '<form role="search"><input id="query" name="q" aria-label="Search" value="PRIVATE_SENTINEL"><button>Search</button></form>';
    const rect = new DOMRect(0, 0, 100, 20);
    const rects: DOMRectList = { 0: rect, length: 1, item: () => rect, [Symbol.iterator]: () => [rect].values() };
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rects);
    const first = content.extractPageContext().controls!;
    const second = content.extractPageContext().controls!;
    expect(first).toHaveLength(2);
    expect(first[0]?.search).toBe(true);
    expect(first[0]?.selector).toBe(second[0]?.selector);
    expect(document.querySelector(first[0]!.selector)?.id).toBe("query");
    expect(JSON.stringify(first)).not.toContain("PRIVATE_SENTINEL");
  });
});

describe("fast click target listing", () => {
  beforeEach(() => {
    const rect = new DOMRect(0, 10, 100, 20);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
      0: rect, length: 1, item: () => rect, [Symbol.iterator]: () => [rect].values(),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  });

  it("ranks goal matches first, excludes payment and disabled controls, and gives stable selectors", () => {
    document.body.innerHTML = `
      <a href="https://example.com/docs">Docs</a>
      <a href="https://example.com/pricing">Pricing plans</a>
      <a href="https://example.com/pricing" target="_blank">Pricing in a new tab</a>
      <button>Proceed to checkout</button>
      <button disabled>Pricing calculator</button>
      <a href="https://example.com/report.pdf" download>Pricing report</a>`;
    const targets = content.listClickTargets("open the pricing page");
    expect(targets.map((target) => target.label)).toEqual(["Pricing plans", "Pricing in a new tab", "Pricing report", "Docs"]);
    expect(targets.map((target) => target.navigates)).toEqual([true, false, false, true]);
    expect(targets[0]).toMatchObject({ id: "t1", kind: "link", href: "https://example.com/pricing" });
    expect(document.querySelector(targets[0]!.selector)?.textContent).toBe("Pricing plans");
    expect(content.listClickTargets("pricing")[0]!.selector).toBe(targets[0]!.selector);
  });
});
