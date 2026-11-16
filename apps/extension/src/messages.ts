import type { BrowserAction, ClickTarget, PageContext } from "@chrome-gpt-live/shared";
import type { PdfRequest } from "./pdf/pdfService";
import type { FastScope, FastCommand } from "@chrome-gpt-live/shared";

export type { PdfRequest, PdfResponse } from "./pdf/pdfService";

/** Messages handled only by the offscreen PDF reader document. */
export type OffscreenMessage = { target: "offscreen"; request: PdfRequest };

export type DocumentKindResponse = { ok: true; contentType: string } | { ok: false; error: string };

export type ExtensionMessage =
  | { type: "FAST_BIND" | "FAST_CANCEL" | "FAST_SNAPSHOT"; scope: FastScope }
  | { type: "FAST_EXECUTE"; command: FastCommand }
  | { type: "GET_SESSION_TAB" }
  | { type: "GET_PAGE_CONTEXT"; tabId: number; query?: string }
  | { type: "LIST_CLICK_TARGETS"; tabId: number; goal: string }
  | { type: "AWAIT_NAVIGATION"; tabId: number; fromUrl: string; timeoutMs: number }
  | {
      type: "EXECUTE_ACTION";
      tabId: number;
      action: BrowserAction;
      confirmed?: boolean;
      confirmationId?: string;
      requireFreshConfirmation?: boolean;
      preventReplayRunId?: string;
    }
  | { type: "CAPTURE_VIEWPORT"; tabId: number }
  | { type: "OPEN_ASSISTANT_TAB"; openerTabId: number; url: string }
  | { type: "NAVIGATE_TAB"; tabId: number; url: string }
  | { type: "GO_BACK"; tabId: number };

export type PageContextResponse = { ok: true; page: PageContext | null } | { ok: false; error: string };

export type ClickTargetsResponse =
  | { ok: true; targets: ClickTarget[]; page: { title: string; url: string } }
  | { ok: false; error: string };
