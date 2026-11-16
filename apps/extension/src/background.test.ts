import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageContext } from "@chrome-gpt-live/shared";

const chromeMock = {
  runtime: {
    onInstalled: { addListener: vi.fn() }, onMessage: { addListener: vi.fn() }, getManifest: vi.fn(),
    getContexts: vi.fn(), sendMessage: vi.fn(), getURL: vi.fn((path: string) => `chrome-extension://self/${path}`),
  },
  tabs: {
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    onRemoved: { addListener: vi.fn(), removeListener: vi.fn() },
    get: vi.fn(), query: vi.fn(), update: vi.fn(), create: vi.fn(), reload: vi.fn(),
    sendMessage: vi.fn(), goBack: vi.fn(), captureVisibleTab: vi.fn(),
  },
  scripting: { executeScript: vi.fn() },
  offscreen: { createDocument: vi.fn() },
  extension: { isAllowedFileSchemeAccess: vi.fn() },
};
let handleMessage: typeof import("./background")["handleMessage"];
let runtimeListener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => unknown;
let documentType = "text/html";
const page: PageContext = {
  url: "https://example.com/new", title: "Loaded article", description: "", byline: "",
  excerpt: "Article text", headings: [], links: [], citations: [], capturedAt: "2026-09-23T00:00:00Z",
};
const pdfUrl = "https://example.com/reports/q3";
const pdfPage: PageContext = {
  url: pdfUrl, title: "Q3 report", description: "", byline: "", excerpt: "[Page 1]\nRevenue grew",
  headings: [], links: [], citations: [{ id: "pdf-p1-1", text: "Revenue grew", page: 1 }], controls: [],
  document: { type: "pdf", pageCount: 3, truncated: false }, capturedAt: "2026-09-23T00:00:00Z",
};
const contentCalls = (type: string) =>
  chromeMock.tabs.sendMessage.mock.calls.filter(([, message]) => (message as { type: string }).type === type);
beforeAll(async () => {
  vi.stubGlobal("chrome", chromeMock);
  ({ handleMessage } = await import("./background"));
  runtimeListener = chromeMock.runtime.onMessage.addListener.mock.calls[0]![0];
});
beforeEach(() => {
  vi.clearAllMocks();
  documentType = "text/html";
  chromeMock.tabs.get.mockResolvedValue({ id: 42, url: page.url, status: "complete", active: true, windowId: 1 });
  chromeMock.tabs.query.mockResolvedValue([{ id: 42 }]);
  chromeMock.tabs.sendMessage.mockImplementation(async (_tabId: number, message: { type: string }) =>
    message.type === "GET_DOCUMENT_KIND" ? { ok: true, contentType: documentType } : { ok: true, page });
  chromeMock.runtime.getManifest.mockReturnValue({ content_scripts: [{ js: ["content-loader.js"] }] });
  chromeMock.runtime.getContexts.mockResolvedValue([]);
  chromeMock.runtime.sendMessage.mockResolvedValue({ ok: true, page: pdfPage });
  chromeMock.offscreen.createDocument.mockResolvedValue(undefined);
  chromeMock.extension.isAllowedFileSchemeAccess.mockResolvedValue(false);
  chromeMock.scripting.executeScript.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("exact fast-run tab binding", () => {
  const scope = { sessionId: "session-1", runId: "fast-background-1", revision: 1, tabId: 42, expiresAtMs: Date.now() + 60000 };
  it("rejects an unbound scope even on an otherwise allowed tab", async () => {
    expect(await handleMessage({ type: "FAST_SNAPSHOT", scope })).toMatchObject({ ok: false });
    expect(contentCalls("FAST_SNAPSHOT")).toHaveLength(0);
  });
  it("binds HTML only and forwards snapshot reads for the exact current run", async () => {
    expect(await handleMessage({ type: "FAST_BIND", scope })).toMatchObject({ ok: true });
    await handleMessage({ type: "FAST_SNAPSHOT", scope });
    expect(contentCalls("FAST_SNAPSHOT")).toHaveLength(1);
    expect(await handleMessage({ type: "FAST_SNAPSHOT", scope: { ...scope, runId: "wrong" } })).toMatchObject({ ok: false });
    expect(contentCalls("FAST_SNAPSHOT")).toHaveLength(1);
    await handleMessage({ type: "FAST_CANCEL", scope });
    expect(await handleMessage({ type: "FAST_SNAPSHOT", scope })).toMatchObject({ ok: false });
    expect(await handleMessage({ type: "FAST_BIND", scope })).toMatchObject({ ok: false });
  });
  it("does not send fast input into the built-in PDF viewer", async () => {
    documentType = "application/pdf";
    const pdfScope = { ...scope, runId: "pdf-fast-run" };
    expect(await handleMessage({ type: "FAST_BIND", scope: pdfScope })).toMatchObject({ ok: false });
    expect(contentCalls("FAST_BIND")).toHaveLength(0);
  });
  it("never retries an execution message after an uncertain port closure", async () => {
    const run = { ...scope, runId: "uncertain-run" };
    await handleMessage({ type: "FAST_BIND", scope: run });
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error("The message port closed before a response was received."));
    await expect(handleMessage({ type: "FAST_EXECUTE", command: {
      scope: run, documentId: "doc-1", snapshotId: "snapshot-1", stepId: "step-1", operation: "CLICK", targetId: "t1",
    } })).rejects.toThrow("port closed");
    expect(contentCalls("FAST_EXECUTE")).toHaveLength(1);
  });
  it("rejects an expired run before forwarding input but still permits its cancellation", async () => {
    const expired = { ...scope, runId: "expired-run", expiresAtMs: Date.now() - 1 };
    expect(await handleMessage({ type: "FAST_BIND", scope: expired })).toMatchObject({ ok: false, outcome: "rejected" });
    expect(contentCalls("FAST_BIND")).toHaveLength(0);
    expect(await handleMessage({ type: "FAST_CANCEL", scope: expired })).toMatchObject({ ok: true });
  });
});

describe("browser action reliability", () => {
  it.each(["chrome://newtab/", "chrome://new-tab-page/", "chrome://new-tab-page-third-party/", "about:blank", "chrome-search://local-ntp/local-ntp.html"])(
    "starts conversations on %s without injecting or reading internal browser content", async (url) => {
      const tab = { id: 42, url, title: "New tab", active: true, windowId: 1, status: "complete" };
      chromeMock.tabs.query.mockResolvedValue([tab]);
      chromeMock.tabs.get.mockResolvedValue(tab);
      expect(await handleMessage({ type: "GET_SESSION_TAB" })).toMatchObject({ ok: true, tabId: 42, url });
      expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page: null });
      expect(await handleMessage({
        type: "EXECUTE_ACTION", tabId: 42, action: { name: "get_page_context", arguments: {} },
      })).toMatchObject({ ok: true, data: null });
      expect(await handleMessage({
        type: "EXECUTE_ACTION", tabId: 42, action: { name: "click", arguments: { text: "Shortcut" } },
      })).toMatchObject({ ok: false, summary: expect.stringContaining("open a website first") });
      expect(await handleMessage({ type: "CAPTURE_VIEWPORT", tabId: 42 })).toMatchObject({ ok: false });
      expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
      expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
      expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
    },
  );

  it.each(["chrome://settings/", "chrome-extension://other-extension/index.html", "file:///private.txt"])(
    "still rejects protected starting pages such as %s", async (url) => {
      chromeMock.tabs.query.mockResolvedValue([{ id: 42, url }]);
      expect(await handleMessage({ type: "GET_SESSION_TAB" })).toMatchObject({ ok: false });
    },
  );

  it("reads the destination instead of reporting an empty tab during pending navigation", async () => {
    chromeMock.tabs.get.mockResolvedValueOnce({ id: 42, url: "chrome://newtab/", pendingUrl: page.url, status: "loading" });
    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page });
    expect(contentCalls("GET_PAGE_CONTEXT")).toHaveLength(1);
  });

  it("navigates an empty conversation tab to a website and returns its actual context", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, url: "chrome://newtab/" }]);
    await handleMessage({ type: "GET_SESSION_TAB" });
    const result = await handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "navigate", arguments: { url: page.url } },
    });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: page.url });
    expect(result).toMatchObject({ ok: true, data: { tabId: 42, page } });
  });

  it("returns an empty context after navigating back to a new tab", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, url: "chrome://newtab/", status: "complete" });
    expect(await handleMessage({ type: "GO_BACK", tabId: 42 })).toMatchObject({ ok: true, data: { tabId: 42, page: null } });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("returns freshly loaded page context with navigation so Astra does not need another round trip", async () => {
    const result = await handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "navigate", arguments: { url: page.url } },
    });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: page.url });
    expect(result).toMatchObject({ ok: true, data: { tabId: 42, page } });
  });

  it("waits for the asynchronous content loader only when no receiver exists", async () => {
    vi.useFakeTimers();
    const absent = new Error("Could not establish connection. Receiving end does not exist.");
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(absent).mockRejectedValueOnce(absent);
    const request = handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await request).toEqual({ ok: true, page });
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledOnce();
    // Two failed document checks, one successful check, then the page read.
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledTimes(4);
  });

  it("never retries side-effecting actions when a message port closes after execution may have begun", async () => {
    chromeMock.tabs.sendMessage.mockImplementation(async (_tabId: number, message: { type: string }) => {
      if (message.type === "GET_DOCUMENT_KIND") return { ok: true, contentType: "text/html" };
      throw new Error("The message port closed");
    });
    await expect(handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "click", arguments: { text: "Publish" } },
    })).rejects.toThrow("action may have started");
    expect(contentCalls("EXECUTE_ACTION")).toHaveLength(1);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("retries delivery while Chrome reports that a freshly loaded frame is not ready", async () => {
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error("Frame with ID 0 is not ready"));
    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page });
    expect(contentCalls("GET_DOCUMENT_KIND")).toHaveLength(2);
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("never captures an unrelated foreground tab when the conversation tab is hidden", async () => {
    chromeMock.tabs.get.mockResolvedValue({ id: 42, windowId: 1, active: false });
    const result = await handleMessage({ type: "CAPTURE_VIEWPORT", tabId: 42 });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("must be visible") });
    expect(chromeMock.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("explains how to recover when Chrome retains a content script from an older build", async () => {
    chromeMock.tabs.sendMessage.mockRejectedValueOnce(new Error("Receiving end does not exist"));
    chromeMock.scripting.executeScript.mockRejectedValueOnce(new Error("Could not load file: 'assets/old-loader.js'."));
    await expect(handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 }))
      .rejects.toThrow("click Reload for Chrome GPT Live at chrome://extensions");
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledOnce();
  });
});

describe("PDF support", () => {
  function pdfTab(url = pdfUrl) {
    documentType = "application/pdf";
    let currentUrl = url;
    let loadingReads = 0;
    chromeMock.tabs.get.mockImplementation(async () => ({
      id: 42, url: currentUrl, status: loadingReads-- > 0 ? "loading" : "complete", active: true, windowId: 1,
    }));
    chromeMock.tabs.update.mockImplementation(async (_tabId: number, properties: { url: string }) => {
      currentUrl = properties.url;
    });
    chromeMock.tabs.reload.mockImplementation(async () => {
      loadingReads = 1;
    });
  }

  it("reads PDFs shown in Chrome's viewer through the offscreen pdf.js reader", async () => {
    pdfTab();

    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42, query: "revenue" })).toEqual({ ok: true, page: pdfPage });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: "src/offscreen/index.html", reasons: ["WORKERS"],
    }));
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: "offscreen", request: { type: "PDF_CONTEXT", url: pdfUrl, query: "revenue" },
    });
    expect(contentCalls("GET_PAGE_CONTEXT")).toHaveLength(0);

    chromeMock.runtime.getContexts.mockResolvedValue([{ contextType: "OFFSCREEN_DOCUMENT" }]);
    await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 });
    expect(chromeMock.offscreen.createDocument).toHaveBeenCalledOnce();
  });

  it("reads committed PDFs even when Chrome's viewer leaves the tab loading", async () => {
    pdfTab();
    chromeMock.tabs.get.mockResolvedValue({ id: 42, url: pdfUrl, pendingUrl: `${pdfUrl}#page=2`, status: "loading", active: true, windowId: 1 });

    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page: pdfPage });
  });

  it("waits while a PDF tab is navigating to a different document", async () => {
    vi.useFakeTimers();
    pdfTab();
    chromeMock.tabs.get.mockResolvedValue({ id: 42, url: pdfUrl, pendingUrl: page.url, status: "loading", active: true, windowId: 1 });

    const assertion = expect(handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).rejects.toThrow("still loading after 15 seconds");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(chromeMock.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("still waits for ordinary web pages that are loading", async () => {
    vi.useFakeTimers();
    chromeMock.tabs.get.mockResolvedValue({ id: 42, url: page.url, status: "loading", active: true, windowId: 1 });

    const assertion = expect(handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).rejects.toThrow("still loading after 15 seconds");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(contentCalls("GET_PAGE_CONTEXT")).toHaveLength(0);
  });

  it("waits for the offscreen reader to start listening and reports its errors", async () => {
    pdfTab();
    chromeMock.runtime.sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({ ok: false, error: "This PDF is password-protected." });

    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: false, error: "This PDF is password-protected." });
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("recognizes PDF tabs when Chrome blocks the page helper from its viewer", async () => {
    pdfTab("https://example.com/download.pdf");
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    chromeMock.scripting.executeScript.mockRejectedValue(new Error('Cannot access contents of url "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html".'));

    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page: pdfPage });
  });

  it("jumps to the cited PDF page and asks the viewer to highlight the passage", async () => {
    pdfTab(`${pdfUrl}#page=1`);
    chromeMock.runtime.sendMessage.mockResolvedValue({
      ok: true, location: { page: 3, text: "Revenue grew by 12 percent.", quote: "Revenue grew", citationId: "pdf-p3-1", matched: true },
    });

    const result = await handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "highlight", arguments: { citationId: "pdf-p3-1", text: "Revenue grew" } },
    });

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      target: "offscreen", request: { type: "PDF_LOCATE", url: `${pdfUrl}#page=1`, citationId: "pdf-p3-1", text: "Revenue grew" },
    });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: `${pdfUrl}#page=3:~:text=Revenue%20grew` });
    expect(chromeMock.tabs.reload).toHaveBeenCalledWith(42);
    expect(result).toMatchObject({
      ok: true,
      summary: expect.stringContaining("Opened page 3"),
      data: { page: 3, citationId: "pdf-p3-1" },
    });
    expect(contentCalls("EXECUTE_ACTION")).toHaveLength(0);
  });

  it("explains that PDF viewer content cannot be clicked, typed into, or scrolled", async () => {
    pdfTab();

    for (const action of [
      { name: "click", arguments: { text: "Next" } },
      { name: "scroll", arguments: { direction: "down", amount: 700 } },
      { name: "type_text", arguments: { selector: "input", text: "x", submit: false } },
    ] as const) {
      expect(await handleMessage({ type: "EXECUTE_ACTION", tabId: 42, action })).toMatchObject({
        ok: false, summary: expect.stringContaining("Use highlight"),
      });
    }
    expect(await handleMessage({ type: "LIST_CLICK_TARGETS", tabId: 42, goal: "next page" })).toMatchObject({
      ok: false, error: expect.stringContaining("PDF"),
    });
    expect(contentCalls("EXECUTE_ACTION")).toHaveLength(0);
    expect(contentCalls("LIST_CLICK_TARGETS")).toHaveLength(0);
  });

  it("opens PDF links without asking for download confirmation", async () => {
    const result = await handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "navigate", arguments: { url: "https://example.com/paper.pdf" } },
    });
    expect(chromeMock.tabs.update).toHaveBeenCalledWith(42, { url: "https://example.com/paper.pdf" });
    expect(result).not.toHaveProperty("requiresConfirmation");
    expect(await handleMessage({
      type: "EXECUTE_ACTION", tabId: 42, action: { name: "navigate", arguments: { url: "https://example.com/setup.zip" } },
    })).toMatchObject({ requiresConfirmation: true });
  });

  it("explains how to allow local PDFs when file access is off", async () => {
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, url: "file:///C:/Docs/plan.pdf" }]);

    expect(await handleMessage({ type: "GET_SESSION_TAB" })).toMatchObject({
      ok: false, error: expect.stringContaining("Allow access to file URLs"),
    });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("uses local PDFs, but not other local files, when file access is on", async () => {
    chromeMock.extension.isAllowedFileSchemeAccess.mockResolvedValue(true);
    pdfTab("file:///C:/Docs/plan.pdf");
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, url: "file:///C:/Docs/plan.pdf", title: "" }]);
    chromeMock.tabs.captureVisibleTab.mockResolvedValue("data:image/jpeg;base64,AAAA");

    expect(await handleMessage({ type: "GET_SESSION_TAB" })).toMatchObject({ ok: true, tabId: 42, title: "plan.pdf" });
    expect(await handleMessage({ type: "GET_PAGE_CONTEXT", tabId: 42 })).toEqual({ ok: true, page: pdfPage });
    expect(await handleMessage({ type: "CAPTURE_VIEWPORT", tabId: 42 })).toMatchObject({ ok: true });

    documentType = "text/plain";
    chromeMock.tabs.query.mockResolvedValue([{ id: 42, url: "file:///C:/Docs/notes.txt" }]);
    expect(await handleMessage({ type: "GET_SESSION_TAB" })).toMatchObject({
      ok: false, error: expect.stringContaining("Only PDF files"),
    });
  });

  it("leaves offscreen reader messages to the offscreen document", () => {
    const sendResponse = vi.fn();
    expect(runtimeListener({ target: "offscreen", request: { type: "PDF_CONTEXT", url: pdfUrl } }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
