import {
  FAST_LIMITS, fastCommandSchema, fastSnapshotSchema, fastScopeSchema, irreversibleActionPattern, paymentPattern,
  type ActionResult, type FastCommand, type FastScope, type FastSnapshot, type FastStepResult,
} from "@chrome-gpt-live/shared";

type Policy = {
  label: (element: HTMLElement) => string;
  check: (element: HTMLElement) => ActionResult | undefined;
};
const CLICKABLE = 'a[href],button,summary,[role="button"],[role="tab"],[role="menuitem"],input[type="checkbox"],[role="checkbox"]';

export function createFastBrowser(policy: Policy) {
  const documentId = crypto.randomUUID();
  let scope: FastScope | undefined;
  let snapshot: FastSnapshot | undefined;
  let handles = new Map<string, { element: HTMLElement; signature: string }>();
  const attempts = new Set<string>();
  const deliveredClicks = new Map<string, WeakSet<HTMLElement>>();
  const sameScope = (value: FastScope) => scope && JSON.stringify(scope) === JSON.stringify(value);
  const expired = () => !scope || Date.now() >= scope.expiresAtMs;
  const visible = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return element.isConnected && rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
      rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth &&
      !element.closest("[hidden],[inert]") && style.visibility === "visible" && style.display !== "none" &&
      Number(style.opacity || 1) > 0 && !element.matches(":disabled,[aria-disabled='true']") &&
      !ancestorInvisible(element.parentElement);
  };
  const state = (element: HTMLElement) => JSON.stringify({
    checked: element instanceof HTMLInputElement ? element.checked : element.getAttribute("aria-checked"),
    expanded: element.getAttribute("aria-expanded"), selected: element.getAttribute("aria-selected"),
    open: element instanceof HTMLDetailsElement ? element.open : element.closest("details")?.open,
  });
  const signature = (element: HTMLElement) => JSON.stringify({
    label: policy.label(element), href: element.getAttribute("href"), role: element.getAttribute("role"),
    state: state(element), type: element.getAttribute("type"),
    form: element.closest("form")?.outerHTML.replace(/value=(["']).*?\1/g, "").slice(0, 1500),
    nearby: element.parentElement !== document.body ? element.parentElement?.textContent?.replace(/\s+/g, " ").slice(0, 500) : undefined,
  });
  const viewport = () => ({
    x: scrollX, y: scrollY, width: innerWidth, height: innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  });
  const safe = (element: HTMLElement) => !policy.check(element) &&
    !irreversibleActionPattern.test(policy.label(element)) &&
    !element.closest("select,[role='combobox'],[contenteditable]") &&
    !element.matches("a[download],a[target]:not([target='_self']),input[type='submit']") &&
    !(element instanceof HTMLButtonElement && element.form && element.type === "submit");
  const read = (requested: FastScope): FastSnapshot => {
    if (!sameScope(requested) || expired()) throw new Error("Fast browser run is expired or no longer bound to this document.");
    if (document.contentType !== "text/html") throw new Error("Fast actions require an HTML document.");
    if (paymentPattern.test(location.href)) throw new Error("Fast interaction with payment/checkout pages is blocked.");
    handles = new Map();
    const targets = Array.from(document.querySelectorAll<HTMLElement>(CLICKABLE))
      .filter((element) => visible(element) && safe(element)).slice(0, 30).map((element, index) => {
        const id = `t${index + 1}`;
        handles.set(id, { element, signature: signature(element) });
        return {
          id, kind: element.getAttribute("role") || element.tagName.toLowerCase(),
          label: policy.label(element).slice(0, 160), state: state(element).slice(0, 100),
          ...(element instanceof HTMLAnchorElement ? { href: element.href.slice(0, 500) } : {}),
        };
      });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = "";
    for (let node = walker.nextNode(), count = 0; node && count < 1200 && text.length < 3000; node = walker.nextNode(), count++) {
      const parent = node.parentElement;
      if (parent && !parent.closest("script,style,noscript,form,textarea,input,select,[contenteditable],[hidden]") && visible(parent)) {
        text += ` ${node.textContent?.replace(/\s+/g, " ").trim() ?? ""}`;
      }
    }
    const view = viewport();
    snapshot = fastSnapshotSchema.parse({
      documentId, snapshotId: crypto.randomUUID(), url: location.href, title: document.title.slice(0, 300),
      text: text.trim().slice(0, 3000), viewport: view, targets,
      operations: [
        ...(targets.length ? ["CLICK"] : []),
        ...(view.y > 0 ? ["SCROLL_UP"] : []),
        ...(view.y + view.height < view.scrollHeight ? ["SCROLL_DOWN"] : []),
        "WAIT", "DONE", "HANDOFF",
      ],
    });
    return snapshot;
  };
  const changed = (before: FastSnapshot) => JSON.stringify(viewport()) !== JSON.stringify(before.viewport) ||
    location.href !== before.url || [...handles.values()].some(({ element, signature: previous }) =>
      !element.isConnected || signature(element) !== previous);
  const settle = (before: FastSnapshot) => new Promise<void>((resolve) => {
    if (changed(before)) { resolve(); return; }
    const finish = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
    const observer = new MutationObserver(() => { if (changed(before)) finish(); });
    const timer = setTimeout(finish, 150);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  return {
    wasAttempted(runId: string, element: HTMLElement) { return deliveredClicks.get(runId)?.has(element) ?? false; },
    bind(value: unknown) {
      scope = fastScopeSchema.parse(value);
      snapshot = undefined;
      handles.clear();
      attempts.clear();
    },
    cancel(value: FastScope) {
      if (sameScope(value)) { scope = undefined; snapshot = undefined; handles.clear(); }
    },
    snapshot: read,
    async execute(value: FastCommand): Promise<FastStepResult> {
      const command = fastCommandSchema.parse(value);
      const rejected = (summary: string): FastStepResult => ({ ok: false, outcome: "rejected", summary });
      if (!sameScope(command.scope) || expired() || !snapshot || command.documentId !== documentId ||
        command.snapshotId !== snapshot.snapshotId || snapshot.url !== location.href) return rejected("Stale run or document. Nothing executed.");
      if (attempts.has(command.stepId)) return rejected("Duplicate action attempt. Never replay a mutation.");
      if (attempts.size >= FAST_LIMITS.actions) return rejected("Fast action budget exhausted.");
      attempts.add(command.stepId);
      const before = snapshot;
      if (JSON.stringify(viewport()) !== JSON.stringify(before.viewport)) return rejected("Viewport changed. Re-observe before deciding.");
      if (!before.operations.includes(command.operation)) return rejected("Operation was not offered.");
      if (command.operation === "DONE" || command.operation === "HANDOFF") return rejected("Terminal decisions do not execute browser input.");
      let delivered = false;
      try {
        if (command.operation === "CLICK") {
          const target = handles.get(command.targetId ?? "");
          if (!target || !visible(target.element) || !safe(target.element) ||
            signature(target.element) !== target.signature) return rejected("Target changed or requires ordinary action approval.");
          const rect = target.element.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!hit || (hit !== target.element && !target.element.contains(hit))) return rejected("Target is covered by another element.");
          let deliveredNodes = deliveredClicks.get(command.scope.runId);
          if (!deliveredNodes) {
            deliveredNodes = new WeakSet();
            deliveredClicks.set(command.scope.runId, deliveredNodes);
            if (deliveredClicks.size > 32) deliveredClicks.delete(deliveredClicks.keys().next().value!);
          }
          deliveredNodes.add(target.element);
          delivered = true;
          target.element.click();
        } else if (command.operation !== "WAIT") {
          delivered = true;
          window.scrollBy({ top: command.operation === "SCROLL_DOWN" ? 700 : -700, behavior: "instant" });
        }

        await settle(before);
        return { ok: true, outcome: "executed", summary: `${command.operation} executed; task completion is not yet verified.` };
      } catch (cause) {
        return { ok: false, outcome: delivered ? "uncertain" : "rejected", summary: `Fast action failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 1000) };
      }
    },
  };
}

function ancestorInvisible(element: HTMLElement | null): boolean {
  for (let depth = 0; element && depth < 64; depth++, element = element.parentElement) {
    const style = getComputedStyle(element);
    if (Number(style.opacity || 1) === 0 || style.display === "none" || style.visibility !== "visible") return true;
  }
  return element !== null;
}
