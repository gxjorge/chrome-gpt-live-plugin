import {
  paymentPattern,
  pageContextSchema,
  type ActionResult,
  type BrowserAction,
  fastScopeSchema, fastCommandSchema, type FastScope,
} from "@chrome-gpt-live/shared";
import type {
  ClickTargetsResponse,
  DocumentKindResponse,
  ExtensionMessage,
  OffscreenMessage,
  PageContextResponse,
  PdfRequest,
  PdfResponse,
} from "./messages";
import { fileNameFromUrl, pdfViewerUrl, stripFragment } from "./pdf/pdfContext";
import { waitForNavigationStart, waitForTabReady } from "./tabReadiness";

const OFFSCREEN_PATH = "src/offscreen/index.html";
const PDF_READY_POLL_MS = 250;
const PROTECTED_START_ERROR = "Start from a new tab, a regular website, or a PDF. Chrome settings and other protected pages cannot be used.";
const FILE_ACCESS_ERROR = "To use a PDF from your computer, open chrome://extensions, choose Details for Chrome GPT Live, turn on \"Allow access to file URLs\", then reload the PDF tab.";
const LOCAL_FILE_ERROR = "Only PDF files can be used from your computer. Open a website or a PDF instead.";
const PDF_INTERACTION_ERROR = "This tab shows a PDF in Chrome's viewer, which cannot be clicked, typed into, or scrolled by the assistant. Use highlight with a citation or text to jump to a page, navigate to a link from get_page_context, or inspect_viewport to read the visible page.";

type TabKind = { kind: "empty" } | { kind: "web" } | { kind: "pdf"; url: string } | { kind: "blocked"; error?: string };

const assistantTabs = new Set<number>();
const fastRuns = new Map<number, FastScope>();
const revokedFastRuns = new Set<string>();
let creatingOffscreen: Promise<void> | undefined;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  assistantTabs.delete(tabId);
  fastRuns.delete(tabId);
});

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage | OffscreenMessage, _sender, sendResponse: (response: unknown) => void) => {
    if ("target" in message) {
      return false;
    }
    void handleMessage(message).then(sendResponse, (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      sendResponse({ ok: false, error: detail, summary: detail });
    });
    return true;
  },
);

export async function handleMessage(message: ExtensionMessage): Promise<unknown> {
  switch (message.type) {
    case "FAST_BIND":
    case "FAST_CANCEL":
    case "FAST_SNAPSHOT":
    case "FAST_EXECUTE": {
      const command = message.type === "FAST_EXECUTE" ? fastCommandSchema.parse(message.command) : undefined;
      const scope = fastScopeSchema.parse(command ? command.scope : "scope" in message ? message.scope : undefined);
      const { tabId } = scope;
      if (message.type === "FAST_CANCEL") {
        revokedFastRuns.add(scope.runId);
        if (revokedFastRuns.size > 256) revokedFastRuns.delete(revokedFastRuns.values().next().value!);
        if (JSON.stringify(fastRuns.get(tabId)) !== JSON.stringify(scope)) return { ok: true };
        fastRuns.delete(tabId);
        return sendToTab(tabId, message, { readOnly: true });
      }
      if (Date.now() >= scope.expiresAtMs) {
        return { ok: false, error: "Fast run expired.", outcome: "rejected", summary: "Fast run expired. Nothing executed." };
      }
      if (!await isAllowedTab(tabId)) return { ok: false, error: "Fast run tab is outside the assistant session." };
      if (message.type === "FAST_BIND") {
        const tab = await chrome.tabs.get(tabId);
        if ((await classifyTab(tabId, tab.url)).kind !== "web") return { ok: false, error: PDF_INTERACTION_ERROR };
        if (revokedFastRuns.has(scope.runId)) return { ok: false, error: "Fast run was revoked before document binding." };
        fastRuns.set(tabId, scope);
        return sendToTab(tabId, message, { readOnly: true });
      }
      if (JSON.stringify(fastRuns.get(tabId)) !== JSON.stringify(scope)) {
        return { ok: false, error: "Fast run was cancelled or superseded.", outcome: "rejected", summary: "Fast run was cancelled or superseded." };
      }
      // No retry after an execution message has possibly reached the document.
      return chrome.tabs.sendMessage(tabId, message);
    }
    case "GET_SESSION_TAB": {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url || tab?.pendingUrl;
      if (!tab?.id) {
        return { ok: false, error: PROTECTED_START_ERROR };
      }
      if (/^file:/i.test(url ?? "")) {
        const kind = await classifyTab(tab.id, url);
        if (kind.kind !== "pdf") {
          return { ok: false, error: kind.kind === "blocked" && kind.error ? kind.error : PROTECTED_START_ERROR };
        }
      } else if (!isControllableUrl(url) && !isEmptyStartPage(url)) {
        return { ok: false, error: PROTECTED_START_ERROR };
      }
      assistantTabs.add(tab.id);
      return {
        ok: true,
        tabId: tab.id,
        title: tab.title || (isEmptyStartPage(url) ? "New tab" : fileNameFromUrl(url ?? "")),
        url: url ?? "",
      };
    }
    case "GET_PAGE_CONTEXT":
      return readPageContext(message.tabId, message.query);
    case "LIST_CLICK_TARGETS": {
      if (!await isAllowedTab(message.tabId)) {
        return { ok: false, error: "That tab is outside the active assistant session." };
      }
      await waitForReadableTab(message.tabId);
      const tab = await chrome.tabs.get(message.tabId);
      const kind = await classifyTab(message.tabId, tab.url);
      if (kind.kind === "pdf") {
        return { ok: false, error: PDF_INTERACTION_ERROR };
      }
      if (kind.kind !== "web") {
        return { ok: false, error: "There is no website in this tab. Use navigate or open_tab first." };
      }
      return sendToTab<ClickTargetsResponse>(message.tabId, { type: "LIST_CLICK_TARGETS", goal: message.goal });
    }
    case "AWAIT_NAVIGATION": {
      if (!await waitForNavigationStart(message.tabId, message.fromUrl, message.timeoutMs)) {
        return { ok: true, navigated: false };
      }
      return { ...await navigationResult(message.tabId, "Opened the clicked link."), navigated: true };
    }
    case "EXECUTE_ACTION":
      return executeAction(message.tabId, message.action, message.confirmed ?? false, message.confirmationId, message.requireFreshConfirmation, message.preventReplayRunId);
    case "CAPTURE_VIEWPORT": {
      const tab = await chrome.tabs.get(message.tabId);
      if (!tab.windowId) {
        return { ok: false, error: "The conversation tab is no longer available." };
      }
      if (!tab.active) {
        return { ok: false, error: "The conversation tab must be visible before capturing its viewport." };
      }
      const capturable = isControllableUrl(tab.url) ||
        (/^file:/i.test(tab.url ?? "") && (await classifyTab(message.tabId, tab.url)).kind === "pdf");
      if (!capturable) {
        return { ok: false, error: "There is no website to inspect yet. Open a website first; voice conversation can continue." };
      }
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "jpeg",
        quality: 45,
      });
      return { ok: true, screenshot };
    }
    case "OPEN_ASSISTANT_TAB": {
      if (paymentPattern.test(message.url)) {
        return blockedPayment();
      }
      const tab = await chrome.tabs.create({
        url: message.url,
        openerTabId: message.openerTabId,
        active: true,
      });
      if (tab.id === undefined) {
        throw new Error("Chrome did not return the new tab ID.");
      }
      assistantTabs.add(tab.id);
      return navigationResult(tab.id, `Opened ${message.url}`);
    }
    case "NAVIGATE_TAB": {
      if (paymentPattern.test(message.url)) {
        return blockedPayment();
      }
      await chrome.tabs.update(message.tabId, { url: message.url });
      return navigationResult(message.tabId, `Opened ${message.url}`);
    }
    case "GO_BACK": {
      await chrome.tabs.goBack(message.tabId);
      return navigationResult(message.tabId, "Navigated back.");
    }
  }
}

async function executeAction(
  tabId: number,
  action: BrowserAction,
  confirmed: boolean,
  confirmationId?: string,
  requireFreshConfirmation?: boolean,
  preventReplayRunId?: string,
): Promise<ActionResult> {
  if (!await isAllowedTab(tabId)) {
    return { ok: false, summary: "That tab is outside the active assistant session." };
  }

  if (action.name === "navigate") {
    if (!confirmed && isLikelyDownload(action.arguments.url)) {
      return confirmationRequired(`Download from ${action.arguments.url}`);
    }
    return handleMessage({ type: "NAVIGATE_TAB", tabId, url: action.arguments.url }) as Promise<ActionResult>;
  }
  if (action.name === "open_tab") {
    if (!confirmed && isLikelyDownload(action.arguments.url)) {
      return confirmationRequired(`Download from ${action.arguments.url}`);
    }
    return handleMessage({
      type: "OPEN_ASSISTANT_TAB",
      openerTabId: tabId,
      url: action.arguments.url,
    }) as Promise<ActionResult>;
  }
  if (action.name === "go_back") {
    return handleMessage({ type: "GO_BACK", tabId }) as Promise<ActionResult>;
  }
  if (action.name === "get_page_context") {
    const context = await readPageContext(tabId, action.arguments.query);
    return context.ok
      ? { ok: true, summary: context.page ? "Read the current page." : "No website is open. Continue the conversation or navigate to a website.", data: context.page }
      : { ok: false, summary: context.error };
  }

  await waitForReadableTab(tabId);
  const tab = await chrome.tabs.get(tabId);
  const kind = await classifyTab(tabId, tab.url);
  if (kind.kind === "pdf") {
    return executePdfAction(tabId, kind.url, action);
  }
  if (kind.kind !== "web") {
    return { ok: false, summary: kind.kind === "blocked" && kind.error ? kind.error : "There is no readable website in this tab. Use navigate or open_tab to open a website first." };
  }
  return sendToTab<ActionResult>(tabId, {
    type: "EXECUTE_ACTION",
    action,
    confirmed,
    confirmationId,
    requireFreshConfirmation,
    preventReplayRunId,
  });
}

async function executePdfAction(tabId: number, url: string, action: BrowserAction): Promise<ActionResult> {
  if (action.name !== "highlight") {
    return { ok: false, summary: PDF_INTERACTION_ERROR };
  }
  const response = await requestPdf({ type: "PDF_LOCATE", url, citationId: action.arguments.citationId, text: action.arguments.text });
  if (!response.ok) {
    return { ok: false, summary: response.error };
  }
  if (!("location" in response)) {
    return { ok: false, summary: "The PDF reader returned an unexpected response." };
  }
  const { location } = response;
  await showPdfLocation(tabId, pdfViewerUrl(url, location.page, location.quote));
  const requested = action.arguments.text?.trim();
  const summary = !location.matched && requested
    ? `Could not find "${requested}" in the PDF text, so opened page ${location.page}, where the cited passage is.`
    : location.quote
      ? `Opened page ${location.page} of the PDF and asked Chrome's PDF viewer to highlight "${location.quote}". The viewer highlights it only when the text matches exactly; mention the page number when citing it.`
      : `Opened page ${location.page} of the PDF.`;
  return {
    ok: true,
    summary,
    data: { page: location.page, text: location.text, ...(location.citationId ? { citationId: location.citationId } : {}) },
  };
}

/** Chrome's PDF viewer ignores same-document fragment changes, so commit the new fragment and reload the viewer. */
async function showPdfLocation(tabId: number, target: string): Promise<void> {
  let current = (await chrome.tabs.get(tabId)).url ?? "";
  if (current !== target) {
    const before = current;
    await chrome.tabs.update(tabId, { url: target });
    const pageFragment = target.replace(/:~:.*$/, "");
    for (let attempt = 0; attempt < 30; attempt++) {
      current = (await chrome.tabs.get(tabId)).url ?? "";
      if (current !== before && current.startsWith(pageFragment)) {
        break;
      }
      await delay(50);
    }
  }
  await chrome.tabs.reload(tabId);
  if (await waitForNavigationStart(tabId, current, 1000)) {
    await waitForReadableTab(tabId, 8000).catch(() => undefined);
  }
}

async function navigationResult(tabId: number, summary: string): Promise<ActionResult> {
  try {
    const context = await readPageContext(tabId);
    if (!context.ok) {
      return { ok: false, summary: `${summary}, but page reading failed: ${context.error}`, data: { tabId } };
    }
    return { ok: true, summary, data: { tabId, page: context.page === null ? null : pageContextSchema.parse(context.page) } };
  } catch (cause) {
    return {
      ok: false,
      summary: `Navigation started, but the page is not ready: ${cause instanceof Error ? cause.message : String(cause)}`,
      data: { tabId },
    };
  }
}

async function readPageContext(tabId: number, query?: string): Promise<PageContextResponse> {
  let tab = await chrome.tabs.get(tabId);
  if (isEmptyStartPage(tab.url) && !tab.pendingUrl) {
    return { ok: true, page: null };
  }
  await waitForReadableTab(tabId);
  tab = await chrome.tabs.get(tabId);
  const kind = await classifyTab(tabId, tab.url);
  if (kind.kind === "empty") {
    return { ok: true, page: null };
  }
  if (kind.kind === "blocked") {
    return { ok: false, error: kind.error ?? "Chrome does not allow reading this page. Navigate to a website to browse; voice conversation can continue." };
  }
  if (kind.kind === "pdf") {
    const response = await requestPdf({ type: "PDF_CONTEXT", url: kind.url, ...(query ? { query } : {}) });
    if (!response.ok) {
      return response;
    }
    return "page" in response ? { ok: true, page: response.page } : { ok: false, error: "The PDF reader returned an unexpected response." };
  }
  return sendToTab<PageContextResponse>(tabId, { type: "GET_PAGE_CONTEXT", ...(query ? { query } : {}) });
}

/**
 * Chrome's PDF viewer can leave a tab "loading" long after the PDF commits. PDF text is fetched
 * separately, so a committed PDF is readable without waiting for the viewer to finish.
 */
async function waitForReadableTab(tabId: number, timeoutMs = 15000): Promise<void> {
  const ready = waitForTabReady(tabId, timeoutMs);
  ready.catch(() => undefined);
  for (;;) {
    if (await Promise.race([ready.then(() => true), delay(PDF_READY_POLL_MS).then(() => false)])) {
      return;
    }
    if (await Promise.race([ready.then(() => true), isCommittedPdf(tabId)])) {
      return;
    }
  }
}

async function isCommittedPdf(tabId: number): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  const sameResource = !tab.pendingUrl || (tab.url && stripFragment(tab.pendingUrl) === stripFragment(tab.url));
  if (!tab.url || !sameResource || !(isControllableUrl(tab.url) || /^file:/i.test(tab.url))) {
    return false;
  }
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_DOCUMENT_KIND" }) as DocumentKindResponse | undefined;
    return response?.ok === true && response.contentType === "application/pdf";
  } catch {
    return false;
  }
}

async function classifyTab(tabId: number, url?: string): Promise<TabKind> {
  if (!url || isEmptyStartPage(url)) {
    return { kind: "empty" };
  }
  if (isControllableUrl(url)) {
    return await isPdfDocument(tabId, url) ? { kind: "pdf", url } : { kind: "web" };
  }
  if (/^file:/i.test(url)) {
    if (!await chrome.extension.isAllowedFileSchemeAccess()) {
      return { kind: "blocked", ...(hasPdfExtension(url) ? { error: FILE_ACCESS_ERROR } : {}) };
    }
    return await isPdfDocument(tabId, url) ? { kind: "pdf", url } : { kind: "blocked", error: LOCAL_FILE_ERROR };
  }
  return { kind: "blocked" };
}

async function isPdfDocument(tabId: number, url: string): Promise<boolean> {
  try {
    const response = await sendToTab<DocumentKindResponse | undefined>(tabId, { type: "GET_DOCUMENT_KIND" }, { readOnly: true });
    if (response?.ok) {
      return response.contentType === "application/pdf";
    }
  } catch (cause) {
    // Chrome may refuse injection into its PDF viewer; that also identifies a PDF.
    const detail = cause instanceof Error ? cause.message : String(cause);
    if (!hasPdfExtension(url) && !/cannot access contents of url "?chrome-extension:/i.test(detail) && !/message port closed/i.test(detail)) {
      throw cause;
    }
  }
  return hasPdfExtension(url);
}

function hasPdfExtension(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

async function requestPdf(request: PdfRequest): Promise<PdfResponse> {
  await ensureOffscreenDocument();
  const message: OffscreenMessage = { target: "offscreen", request };
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage(message) as PdfResponse | undefined;
      return response ?? { ok: false, error: "The PDF reader did not respond. Retry, or use inspect_viewport to read the visible page." };
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (attempt >= 20 || !detail.includes("Receiving end does not exist")) {
        return { ok: false, error: `The PDF reader is unavailable (${detail}). Use inspect_viewport to read the visible page.` };
      }
      await delay(50);
    }
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (contexts.length) {
    return;
  }
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["WORKERS"],
    justification: "Read the text of PDF files shown in Chrome's PDF viewer with pdf.js.",
  }).catch((cause: unknown) => {
    if (!/single offscreen document/i.test(cause instanceof Error ? cause.message : String(cause))) {
      throw cause;
    }
  }).finally(() => {
    creatingOffscreen = undefined;
  });
  await creatingOffscreen;
}

async function isAllowedTab(tabId: number): Promise<boolean> {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id === tabId || assistantTabs.has(tabId);
}

async function sendToTab<T>(tabId: number, payload: object, options: { readOnly?: boolean } = {}): Promise<T> {
  const failure = (detail: string) =>
    new Error(options.readOnly ? detail : `${detail} The action may have started; inspect the page before retrying.`);
  try {
    return await sendWhenFrameReady<T>(tabId, payload);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!message.includes("Receiving end does not exist")) {
      throw failure(message);
    }
    const contentScript = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
    if (!contentScript) {
      throw new Error("The extension content script is unavailable.");
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [contentScript],
      });
    } catch (injectionCause) {
      const detail = injectionCause instanceof Error ? injectionCause.message : String(injectionCause);
      if (/could not load file/i.test(detail)) {
        throw new Error("Chrome is using an older extension build. Deactivate, click Reload for Chrome GPT Live at chrome://extensions, refresh the article tab, then Activate again.");
      }
      throw injectionCause;
    }
    // CRX's loader imports the actual content script asynchronously.
    for (let attempt = 0; attempt < 20; attempt++) {
      await delay(50);
      try {
        return await chrome.tabs.sendMessage(tabId, payload) as T;
      } catch (retryCause) {
        const detail = retryCause instanceof Error ? retryCause.message : String(retryCause);
        if (!detail.includes("Receiving end does not exist")) {
          throw failure(detail);
        }
      }
    }
    throw new Error("The page helper did not become available. Refresh the page and retry.");
  }
}

/** Retries only while Chrome reports that the frame is not ready, which means the message was not delivered. */
async function sendWhenFrameReady<T>(tabId: number, payload: object): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload) as T;
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (attempt >= 20 || !/Frame with ID \d+ is not ready/i.test(detail)) {
        throw cause;
      }
      await delay(50);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isControllableUrl(url?: string): boolean {
  return Boolean(url && /^https?:\/\//i.test(url));
}

function isEmptyStartPage(url = ""): boolean {
  return /^about:blank(?:[?#].*)?$/i.test(url) ||
    /^chrome:\/\/(?:newtab|new-tab-page|new-tab-page-third-party)\/?(?:[?#].*)?$/i.test(url) ||
    /^chrome-search:\/\/local-ntp\/local-ntp\.html(?:[?#].*)?$/i.test(url);
}

function blockedPayment(): ActionResult {
  return {
    ok: false,
    summary: "Payment and checkout actions are blocked by policy.",
  };
}

// PDFs open in Chrome's viewer, so they are not treated as downloads.
function isLikelyDownload(url: string): boolean {
  return /\.(?:zip|exe|msi|dmg|pkg|docx?|xlsx?|pptx?|csv|tar|gz|7z)(?:$|[?#])/i.test(url);
}

function confirmationRequired(summary: string): ActionResult {
  return {
    ok: false,
    summary,
    requiresConfirmation: true,
    confirmationId: crypto.randomUUID(),
  };
}
