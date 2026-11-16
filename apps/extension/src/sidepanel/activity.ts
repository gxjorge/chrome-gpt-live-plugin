import type { BrowserAction, PageContext } from "@chrome-gpt-live/shared";

export type ActivityPhase = "idle" | "connecting" | "thinking" | "acting" | "confirming" | "answering" | "error";
export type Activity = { phase: ActivityPhase; label: string; since: number };
export type ActivityUpdate = Pick<Activity, "phase" | "label">;

/** Short source label for the side panel header, e.g. "example.com" or "PDF · 12 pages · Local file". */
export function pageLabel(page: PageContext): string {
  let source = "";
  try {
    const url = new URL(page.url);
    source = url.protocol === "file:" ? "Local file" : url.hostname;
  } catch {
    source = page.url;
  }
  if (page.document?.type === "pdf") {
    const pages = page.document.pageCount;
    return `PDF · ${pages} ${pages === 1 ? "page" : "pages"} · ${source}`;
  }
  return source;
}

export function actionLabel(action: BrowserAction): string {
  switch (action.name) {
    case "get_page_context": return "Reading the current page";
    case "navigate": return `Opening ${new URL(action.arguments.url).hostname}`;
    case "open_tab": return `Opening a tab at ${new URL(action.arguments.url).hostname}`;
    case "click": return action.arguments.text ? `Clicking "${action.arguments.text.slice(0, 65)}"` : "Clicking a page control";
    case "find_and_click": return `Asking MD-1 to click "${action.arguments.goal.slice(0, 65)}"`;
    case "type_text": return action.arguments.submit ? "Filling and submitting a form" : "Filling a page field";
    case "scroll": return `Scrolling ${action.arguments.direction}`;
    case "highlight": return "Finding the referenced passage";
    case "go_back": return "Returning to the previous page";
    case "inspect_viewport": return "Asking Astra to inspect the visible page";
  }
}

export function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (cause: unknown) => { clearTimeout(timer); reject(cause); },
    );
  });
}
