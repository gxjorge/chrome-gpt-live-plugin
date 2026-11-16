import { Readability } from "@mozilla/readability";
import {
  irreversibleActionPattern,
  MAX_CLICK_TARGETS,
  paymentPattern,
  type ActionResult,
  type BrowserAction,
  type Citation,
  type ClickTarget,
  type PageContext,
} from "@chrome-gpt-live/shared";
import { createFastBrowser } from "./fastBrowser";
import type { FastScope, FastCommand } from "@chrome-gpt-live/shared";

const HIGHLIGHT_CLASS = "chrome-gpt-live-highlight";
const TEXT_BLOCKS = "p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, dt, dd, figcaption, [role='heading'], [role='paragraph']";
const citationIds = new WeakMap<HTMLElement, string>();
let controlSequence = 0;
let citationSequence = 0;
let targetSequence = 0;
const fastBrowser = createFastBrowser({ label: elementLabel, check: clickPolicy });
const approvalTargets = new Map<string, { element: HTMLElement; signature: string; action: string }>();

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    clearHighlights();
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: { type: string; action?: BrowserAction; confirmed?: boolean; confirmationId?: string; requireFreshConfirmation?: boolean; preventReplayRunId?: string; query?: string; goal?: string; scope?: FastScope; command?: FastCommand },
    _sender,
    sendResponse: (response: unknown) => void,
  ) => {
    if (message.type.startsWith("FAST_")) {
      try {
        if (message.type === "FAST_BIND") { fastBrowser.bind(message.scope); sendResponse({ ok: true }); }
        else if (message.type === "FAST_CANCEL" && message.scope) { fastBrowser.cancel(message.scope); sendResponse({ ok: true }); }
        else if (message.type === "FAST_SNAPSHOT" && message.scope) { sendResponse({ ok: true, snapshot: fastBrowser.snapshot(message.scope) }); }
        else if (message.type === "FAST_EXECUTE" && message.command) {
          void fastBrowser.execute(message.command).then(sendResponse, (cause: unknown) =>
            sendResponse({ ok: false, outcome: "uncertain", summary: errorMessage(cause) }));
          return true;
        } else sendResponse({ ok: false, error: "Invalid fast browser message." });
      } catch (cause) { sendResponse({ ok: false, error: errorMessage(cause) }); }
      return;
    }
    if (message.type === "GET_DOCUMENT_KIND") {
      sendResponse({ ok: true, contentType: document.contentType });
      return;
    }
    if (message.type === "GET_PAGE_CONTEXT") {
      try {
        sendResponse({ ok: true, page: extractPageContext(message.query) });
      } catch (cause) {
        sendResponse({ ok: false, error: errorMessage(cause) });
      }
      return;
    }
    if (message.type === "LIST_CLICK_TARGETS") {
      try {
        sendResponse({ ok: true, targets: listClickTargets(message.goal ?? ""), page: { title: document.title, url: location.href } });
      } catch (cause) {
        sendResponse({ ok: false, error: errorMessage(cause) });
      }
      return;
    }
    if (message.type === "EXECUTE_ACTION" && message.action) {
      void executeAction(message.action, message.confirmed ?? false, message.confirmationId, message.requireFreshConfirmation, message.preventReplayRunId).then(
        sendResponse,
        (cause: unknown) => sendResponse({ ok: false, summary: errorMessage(cause) }),
      );
      return true;
    }
  },
);

export function extractPageContext(query?: string): PageContext {
  const readable = new Readability(document.cloneNode(true) as Document).parse();
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: cleanText(element.textContent ?? ""),
    }))
    .filter((heading) => heading.text)
    .slice(0, 40);
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map((link) => ({
      text: cleanText(link.innerText || link.getAttribute("aria-label") || ""),
      href: link.href,
    }))
    .filter((link) => link.text && /^https?:/i.test(link.href))
    .slice(0, 80);
  const citations = createCitations(query);
  const description =
    document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content ?? "";

  return {
    url: location.href,
    title: readable?.title || document.title,
    description: cleanText(readable?.excerpt || description),
    byline: cleanText(readable?.byline ?? ""),
    excerpt: query ? citations.map((citation) => citation.text).join("\n").slice(0, 12000)
      : cleanText(readable?.textContent ?? document.body.innerText ?? document.body.textContent ?? "").slice(0, 12000),
    headings,
    links,
    citations,
    controls: extractControls(),
    capturedAt: new Date().toISOString(),
  };
}

function extractControls(): NonNullable<PageContext["controls"]> {
  return Array.from(document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), textarea, button, [role="button"], [role="searchbox"], [contenteditable="true"]',
  ))
    .filter((element) => element.getClientRects().length > 0 && !element.matches(":disabled"))
    .slice(0, 60)
    .map((element) => {
      element.dataset.chromeGptLiveControl ||= `control-${++controlSequence}`;
      const form = getForm(element);
      return {
        selector: `[data-chrome-gpt-live-control="${element.dataset.chromeGptLiveControl}"]`,
        label: elementLabel(element),
        kind: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        search: Boolean(form && isSearchForm(element, form)),
        blocked: isPaymentElement(element, elementLabel(element)),
      };
    });
}

const CLICKABLE = 'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="button"], input[type="submit"], summary';

export function listClickTargets(goal: string): ClickTarget[] {
  const terms = normalizeSearchText(goal).split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  const seen = new Set<string>();
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE))
    .filter((element) => isVisible(element) && !element.matches(":disabled, [aria-disabled='true']"))
    .map((element, index) => {
      const label = elementLabel(element);
      const href = element instanceof HTMLAnchorElement && /^https?:/i.test(element.href) ? element.href : undefined;
      return { element, label, href, index };
    })
    .filter(({ element, label, href }) => {
      const key = `${label}|${href ?? ""}`;
      if (!label || seen.has(key) || isPaymentElement(element, label) || (href && paymentPattern.test(href))) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((candidate) => {
      const haystack = normalizeSearchText(`${candidate.label} ${candidate.href ?? ""}`);
      const rect = candidate.element.getBoundingClientRect();
      const inViewport = rect.bottom > 0 && rect.top < window.innerHeight;
      const score = terms.filter((term) => haystack.includes(term)).length * 10 + (inViewport ? 1 : 0);
      return { ...candidate, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_CLICK_TARGETS);

  return candidates.map(({ element, label, href }, position) => {
    element.dataset.chromeGptLiveTarget ||= `target-${++targetSequence}`;
    const anchor = element instanceof HTMLAnchorElement ? element : undefined;
    return {
      id: `t${position + 1}`,
      selector: `[data-chrome-gpt-live-target="${element.dataset.chromeGptLiveTarget}"]`,
      kind: anchor ? "link" : element.getAttribute("role") || element.tagName.toLowerCase(),
      label: label.slice(0, 160),
      ...(href ? { href: href.slice(0, 500) } : {}),
      navigates: Boolean(href && (!anchor?.target || anchor.target === "_self") && !anchor?.hasAttribute("download")),
    };
  });
}

function createCitations(query?: string): Citation[] {
  document.querySelectorAll<HTMLElement>("[data-chrome-gpt-live-citation]")
    .forEach((element) => delete element.dataset.chromeGptLiveCitation);
  const root = document.querySelector("article, main, [role='main']") ?? document.body;
  let candidates = Array.from(root.querySelectorAll<HTMLElement>(TEXT_BLOCKS))
    .filter((element) => isVisible(element) && elementText(element).length >= 8);
  if (query) {
    const normalized = normalizeSearchText(query);
    const terms = normalized.split(/\s+/).filter(Boolean);
    const score = (element: HTMLElement) => {
      const text = normalizeSearchText(elementText(element));
      return (text.includes(normalized) ? terms.length + 1 : 0) + terms.filter((term) => text.includes(term)).length;
    };
    candidates = candidates.map((element) => ({ element, score: score(element) }))
      .filter((match) => match.score > 0).sort((left, right) => right.score - left.score)
      .map((match) => match.element);
  }
  candidates = candidates.slice(0, 40);

  return candidates
    .map((element): Citation => {
      let id = citationIds.get(element);
      if (!id) {
        id = `passage-${++citationSequence}`;
        citationIds.set(element, id);
      }
      element.dataset.chromeGptLiveCitation = id;
      return {
        id,
        text: elementText(element).slice(0, 500),
        selector: `[data-chrome-gpt-live-citation="${id}"]`,
      };
    });
}

export async function executeAction(action: BrowserAction, confirmed: boolean, confirmationId?: string, requireFreshConfirmation = false, preventReplayRunId?: string): Promise<ActionResult> {
  const target = action.name === "click" ? findElement(action.arguments.selector, action.arguments.text) :
    action.name === "type_text" ? document.querySelector(action.arguments.selector) : undefined;
  if (action.name === "click" && preventReplayRunId && target instanceof HTMLElement && fastBrowser.wasAttempted(preventReplayRunId, target)) {
    return { ok: false, summary: "That target already received a fast click in this task. Nothing was replayed; inspect the resulting state." };
  }
  if (confirmed && requireFreshConfirmation && (action.name === "click" || action.name === "type_text")) {
    const proof = confirmationId ? approvalTargets.get(confirmationId) : undefined;
    if (confirmationId) approvalTargets.delete(confirmationId);
    if (!proof || proof.element !== target || !proof.element.isConnected ||
      proof.element.matches(":disabled,[aria-disabled='true']") || proof.signature !== approvalSignature(proof.element) ||
      proof.action !== JSON.stringify(action)) {
      return { ok: false, summary: "The approved target changed. Request a new decision and confirmation." };
    }
  }
  const result = await performAction(action, confirmed);
  if (requireFreshConfirmation && result.requiresConfirmation && result.confirmationId && target instanceof HTMLElement) {
    approvalTargets.set(result.confirmationId, { element: target, signature: approvalSignature(target), action: JSON.stringify(action) });
    if (approvalTargets.size > 32) approvalTargets.delete(approvalTargets.keys().next().value!);
  }
  return result;
}

function approvalSignature(element: HTMLElement): string {
  return JSON.stringify({ label: elementLabel(element), attributes: Array.from(element.attributes).map((item) => [item.name, item.value]),
    form: element.closest("form")?.outerHTML, nearby: element.parentElement?.textContent });
}

async function performAction(action: BrowserAction, confirmed: boolean): Promise<ActionResult> {
  switch (action.name) {
    case "get_page_context":
      return { ok: true, summary: "Captured the current page.", data: extractPageContext(action.arguments.query) };
    case "click":
      return clickElement(action.arguments, confirmed);
    case "type_text":
      return typeIntoElement(action.arguments, confirmed);
    case "scroll":
      window.scrollBy({
        top: action.arguments.direction === "down" ? action.arguments.amount : -action.arguments.amount,
        behavior: "smooth",
      });
      return { ok: true, summary: `Scrolled ${action.arguments.direction}.` };
    case "highlight":
      return highlightPassage(action.arguments.citationId, action.arguments.text);
    case "inspect_viewport":
      return { ok: false, summary: "Viewport inspection is handled by the side panel." };
    case "find_and_click":
      return { ok: false, summary: "Fast clicking is handled by the side panel." };
    case "navigate":
    case "go_back":
    case "open_tab":
      return { ok: false, summary: "Navigation action reached the wrong execution surface." };
  }
}

function clickElement(
  args: { selector?: string | undefined; text?: string | undefined },
  confirmed: boolean,
): ActionResult {
  const element = findElement(args.selector, args.text);
  if (!(element instanceof HTMLElement)) {
    return { ok: false, summary: "No matching clickable element was found." };
  }

  const label = elementLabel(element);
  const policy = clickPolicy(element);
  if (policy && (!confirmed || !policy.requiresConfirmation)) return policy;

  element.scrollIntoView({ behavior: "smooth", block: "center" });
  element.click();
  return { ok: true, summary: `Clicked "${label || element.tagName.toLowerCase()}".` };
}

function clickPolicy(element: HTMLElement): ActionResult | undefined {
  const label = elementLabel(element);
  if (isPaymentElement(element, label) || (element instanceof HTMLAnchorElement && paymentPattern.test(element.href))) {
    return { ok: false, summary: "Payment and checkout actions are blocked by policy." };
  }
  if (irreversibleActionPattern.test(label)) {
    return confirmationRequired(`Click "${label}"`, undefined);
  }
}

function typeIntoElement(
  args: { selector: string; text: string; submit: boolean },
  confirmed: boolean,
): ActionResult {
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
    args.selector,
  );
  if (!element) {
    return { ok: false, summary: `No field matched ${args.selector}.` };
  }
  const label = elementLabel(element);
  if (isPaymentElement(element, label)) {
    return { ok: false, summary: "Typing into payment fields is blocked by policy." };
  }
  if (element.matches(":disabled, [readonly]")) {
    return { ok: false, summary: "This field is disabled or read-only. Read the page controls before trying another field." };
  }
  const form = getForm(element);
  if (args.submit && !form) {
    return {
      ok: false,
      summary: "This field has no form to submit, so no text was entered. Use type_text with submit=false, then click the visible search or submit button.",
    };
  }
  if (args.submit && !confirmed && !(form && isSearchForm(element, form))) {
    return confirmationRequired(`Submit the form after typing into "${label}"`, args);
  }

  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    setNativeValue(element, args.text);
  } else if (element.isContentEditable) {
    element.textContent = args.text;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  } else {
    return { ok: false, summary: "The matched element is not editable." };
  }

  if (args.submit && form) {
    if (!form.reportValidity()) {
      return { ok: false, summary: "The form was not submitted because its validation failed." };
    }
    const submitter = getSubmitter(form);
    if (submitter) {
      form.requestSubmit(submitter);
    } else {
      form.requestSubmit();
    }
  }
  return { ok: true, summary: args.submit ? `Submitted the form for "${label}".` : `Entered text into "${label}".` };
}

function getForm(element: HTMLElement): HTMLFormElement | null {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement
    ? element.form
    : element.closest("form");
}

function getSubmitter(form: HTMLFormElement): HTMLButtonElement | HTMLInputElement | undefined {
  return Array.from(form.elements).find(
    (element): element is HTMLButtonElement | HTMLInputElement =>
      (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
      element.type === "submit" && !element.disabled,
  );
}

function isSearchForm(element: HTMLElement, form: HTMLFormElement): boolean {
  const submitter = getSubmitter(form);
  if ((submitter?.getAttribute("formmethod") || form.method).toLowerCase() !== "get") {
    return false;
  }
  const actionUrl = submitter?.getAttribute("formaction") || form.action;
  if (paymentPattern.test(actionUrl) || irreversibleActionPattern.test(actionUrl)) {
    return false;
  }
  const fields = Array.from(form.elements);
  if (fields.some((field) => isPaymentElement(field, elementLabel(field)) ||
    (field instanceof HTMLInputElement && field.type === "password"))) {
    return false;
  }
  const controlsLabel = fields.map(elementLabel).join(" ");
  if (irreversibleActionPattern.test(controlsLabel)) {
    return false;
  }
  return form.getAttribute("role") === "search" ||
    Boolean(form.closest("search")) ||
    element.getAttribute("role") === "searchbox" ||
    (element instanceof HTMLInputElement && element.type === "search") ||
    ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      /^(q|query|search|search_query)$/i.test(element.name) &&
      /\bsearch\b/i.test(elementLabel(element)));
}

function highlightPassage(citationId?: string, text?: string): ActionResult {
  const cited = citationId ? Array.from(document.querySelectorAll<HTMLElement>("[data-chrome-gpt-live-citation]"))
    .find((element) => element.dataset.chromeGptLiveCitation === citationId) : undefined;
  const element = cited && (!text || normalizeSearchText(elementText(cited)).includes(normalizeSearchText(text)))
    ? cited : findTextElement(text);
  if (!element) {
    return { ok: false, summary: "No matching passage was found. Read fresh page context and highlight using its citation ID plus an exact quote or distinctive phrase from the page." };
  }
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor instanceof HTMLDetailsElement) {
      ancestor.open = true;
    }
  }
  if (!isVisible(element)) {
    return { ok: false, summary: "The matching passage is hidden by the page. Open its section before highlighting it." };
  }

  clearHighlights();
  ensureHighlightStyle();
  element.classList.add(HIGHLIGHT_CLASS);
  element.scrollIntoView({ behavior: "smooth", block: "center" });
  return {
    ok: true,
    summary: "Scrolled to and highlighted the passage. The highlight stays visible until another passage is highlighted or Escape is pressed on the page.",
    data: { text: elementText(element).slice(0, 2000), citationId: element.dataset.chromeGptLiveCitation },
  };
}

function findElement(selector?: string, text?: string): Element | undefined {
  if (selector) {
    try {
      const selected = document.querySelector(selector);
      if (selected) {
        return selected;
      }
    } catch {
      // Fall back to visible text when a model-provided selector is invalid.
    }
  }
  if (!text) {
    return undefined;
  }
  const normalized = cleanText(text).toLowerCase();
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'a, button, [role="button"], input[type="button"], input[type="submit"], summary',
    ),
  ).find((element) => elementLabel(element).toLowerCase().includes(normalized));
}

function findTextElement(text?: string): HTMLElement | undefined {
  if (!text?.trim()) {
    return undefined;
  }
  const normalized = normalizeSearchText(text);
  const matches = (selector: string) => Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((element) => (isVisible(element) || element.closest("details:not([open])")) &&
      normalizeSearchText(elementText(element)).includes(normalized))
    .sort((left, right) => elementText(left).length - elementText(right).length);
  return matches(TEXT_BLOCKS)[0] ?? matches("div, section, span")[0];
}

function elementText(element: HTMLElement): string {
  return cleanText(element.innerText || element.textContent || "");
}

function normalizeSearchText(text: string): string {
  return cleanText(text.normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00ad\u200b]/g, "")).toLowerCase();
}

function isVisible(element: HTMLElement): boolean {
  return element.getClientRects().length > 0 && !element.closest("[hidden]") &&
    !["hidden", "collapse"].includes(getComputedStyle(element).visibility);
}

function isPaymentElement(element: Element, label: string): boolean {
  const input = element instanceof HTMLInputElement ? element :
    element.querySelector("input") ?? element.closest("form")?.querySelector<HTMLInputElement>('input[autocomplete*="cc-"]');
  const metadata = [
    label,
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("aria-label"),
    input?.autocomplete,
    input?.name,
  ]
    .filter(Boolean)
    .join(" ");
  return paymentPattern.test(metadata) || Boolean(input?.autocomplete.split(/\s+/).some((token) => token.startsWith("cc-")));
}

function confirmationRequired(summary: string, data: unknown): ActionResult {
  return {
    ok: false,
    summary,
    data,
    requiresConfirmation: true,
    confirmationId: crypto.randomUUID(),
  };
}

function elementLabel(element: Element): string {
  if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
    return cleanText(element.getAttribute("aria-label") || element.value || element.type).slice(0, 160);
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return cleanText(
      element.getAttribute("aria-label") ||
      Array.from(element.labels ?? []).map((label) => label.textContent).join(" ") ||
      element.placeholder ||
      element.name ||
      element.getAttribute("title") ||
      element.tagName,
    ).slice(0, 160);
  }
  return cleanText(
    element.getAttribute("aria-label") ||
    element.textContent ||
    element.getAttribute("title") ||
    element.tagName,
  ).slice(0, 160);
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLInputElement
    ? HTMLInputElement.prototype
    : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function ensureHighlightStyle(): void {
  if (document.getElementById("chrome-gpt-live-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "chrome-gpt-live-style";
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      background: #fff09a !important;
      color: #17140b !important;
      outline: 3px solid #f2c94c !important;
      outline-offset: 4px !important;
      border-radius: 3px !important;
      transition: background-color 160ms ease !important;
    }
  `;
  document.documentElement.append(style);
}

function clearHighlights(): void {
  document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((element) => {
    element.classList.remove(HIGHLIGHT_CLASS);
  });
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
