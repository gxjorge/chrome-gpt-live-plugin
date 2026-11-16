import {
  type BrowserAction,
  type PageContext,
  type TimelineEntry,
} from "@chrome-gpt-live/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isMicrophonePermissionError, microphoneErrorMessage } from "../microphone";
import type { PageContextResponse } from "../messages";
import { LiveSession } from "./liveSession";
import { ActivityCard } from "./ActivityCard";
import { actionLabel, pageLabel, type Activity } from "./activity";
import { ConfigurationPanel } from "./ConfigurationPanel";
import { ensureCompanion } from "./companion";
import { loadFoundryConfiguration, resolveFoundryConfiguration } from "./configuration";
import { BUILD_ID } from "./protocolDiagnostics";

type PendingConfirmation = {
  action: BrowserAction;
  summary: string;
  complete: (confirmed: boolean) => Promise<void>;
};

type SessionTab = {
  tabId: number;
  title: string;
  url: string;
};

export function App() {
  const [status, setStatus] = useState("Ready");
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [diagnosticNotice, setDiagnosticNotice] = useState("");
  const [tab, setTab] = useState<SessionTab>();
  const [page, setPage] = useState<PageContext>();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingConfirmation>();
  const [taskBusy, setTaskBusy] = useState(false);
  const [activity, setActivity] = useState<Activity>({ phase: "idle", label: "Ready when you are", since: Date.now() });
  const transcriptDraft = useRef<{ speaker: "user" | "assistant"; id: string; text: string } | undefined>(undefined);
  const timelineRef = useRef<HTMLDivElement>(null);

  const addEntry = useCallback((entry: Omit<TimelineEntry, "id" | "timestamp">) => {
    setEntries((current) => [
      ...current,
      { ...entry, id: crypto.randomUUID(), timestamp: Date.now() },
    ]);
  }, []);

  const appendTranscript = useCallback(
    (speaker: "user" | "assistant", delta: string) => {
      const previous = transcriptDraft.current;
      const draft = previous?.speaker === speaker
        ? { ...previous, text: previous.text + delta }
        : { speaker, id: crypto.randomUUID(), text: delta };
      transcriptDraft.current = draft;
      setEntries((current) => {
        if (current.some((entry) => entry.id === draft.id)) {
          return current.map((entry) => entry.id === draft.id ? { ...entry, text: draft.text } : entry);
        }
        return [
          ...current.map((entry) =>
            entry.id === previous?.id ? { ...entry, status: "completed" as const } : entry,
          ),
          {
            id: draft.id,
            kind: speaker,
            text: draft.text,
            timestamp: Date.now(),
            status: "pending",
          },
        ];
      });
    },
    [],
  );

  const session = useMemo(
    () =>
      new LiveSession({
        onStatus: (next) => {
          setStatus(next);
          if (next === "Ready" || next === "Disconnected") {
            setActive(false);
            setPending(undefined);
          }
          if (next === "Disconnected") {
            setEntries((current) => current.map((entry) => entry.status === "pending" ? { ...entry, status: "failed" } : entry));
          }
        },
        onTranscript: appendTranscript,
        onTaskState: (busy) => { setTaskBusy(busy); if (!busy) setPending(undefined); },
        onTaskStep: (id, label, result, durationMs) => {
          setEntries((current) => {
            const entry: TimelineEntry = {
              id: `fast:${id}`, kind: "action", text: result ? `${label} - ${result.summary}` : label,
              timestamp: Date.now(), status: result ? result.ok ? "completed" : "failed" : "pending",
              ...(durationMs !== undefined ? { durationMs } : {}),
            };
            return current.some((item) => item.id === entry.id)
              ? current.map((item) => item.id === entry.id ? entry : item) : [...current, entry];
          });
        },
        onActivity: (next) => setActivity((current) =>
          current.phase === next.phase && current.label === next.label
            ? current : { ...next, since: Date.now() },
        ),
        onActionStart: (action, callId) => {
          setError("");
          setEntries((current) => [...current, {
            id: `action:${callId}`, kind: "action", text: actionLabel(action),
            timestamp: Date.now(), status: "pending",
          }]);
        },
        onAction: (action, result, callId, durationMs) => {
          setEntries((current) => current.map((entry) => entry.id === `action:${callId}` ? {
            ...entry,
            text: `${actionLabel(action)} — ${result.summary}`,
            status: result.ok ? "completed" : result.requiresConfirmation ? "pending" : "failed",
            durationMs,
          } : entry));
        },
        onControllerText: (itemId, text, done) => {
          const id = `controller:${itemId}`;
          setEntries((current) => {
            const existing = current.find((entry) => entry.id === id);
            if (existing) {
              return current.map((entry) => entry.id === id ? {
                ...entry, text: done ? text : entry.text + text, status: done ? "completed" : "pending",
              } : entry);
            }
            return [...current, {
              id, kind: "controller", text, timestamp: Date.now(), status: done ? "completed" : "pending",
            }];
          });
        },
        onPageChanged: (nextPage) => {
          setPage(nextPage);
          setTab((current) => current ? {
            ...current, title: nextPage?.title ?? "New tab", url: nextPage?.url ?? "",
          } : current);
        },
        onError: (message) => {
          setError(message);
          setActivity({ phase: "error", label: message, since: Date.now() });
          addEntry({ kind: "system", text: message, status: "failed" });
        },
        onTabChanged: (tabId) => {
          setTab({ tabId, title: "Assistant tab", url: "" });
          setPage(undefined);
        },
        onConfirmation: (action, result, complete) => {
          setPending({ action, summary: result.summary, complete });
        },
      }),
    [addEntry, appendTranscript],
  );

  useEffect(() => {
    // Warm the companion while the user reads the panel; failures surface on Activate.
    void ensureCompanion().catch(() => undefined);
  }, []);

  useEffect(() => {
    return () => {
      void session.stop();
    };
  }, [session]);

  useEffect(() => {
    timelineRef.current?.scrollTo({
      top: timelineRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  async function toggleSession(): Promise<void> {
    setError("");
    if (active) {
      await session.stop();
      setActive(false);
      setPending(undefined);
      transcriptDraft.current = undefined;
      setEntries((current) => current.map((entry) => entry.status === "pending" ? {
        ...entry,
        status: entry.kind === "action" || entry.kind === "controller" ? "failed" : "completed",
      } : entry));
      addEntry({ kind: "system", text: "Conversation ended.", status: "completed" });
      return;
    }

    setStarting(true);
    try {
      const configuration = await loadFoundryConfiguration();
      const effective = await resolveFoundryConfiguration(configuration);
      if (!effective.ready) {
        setConfigurationOpen(true);
        throw new Error("Set your Foundry project in Configuration before starting a conversation.");
      }
      const sessionTab = await chrome.runtime.sendMessage({ type: "GET_SESSION_TAB" }) as
        | ({ ok: true } & SessionTab)
        | { ok: false; error: string };
      if (!sessionTab.ok) {
        throw new Error(sessionTab.error);
      }
      const contextResponse = await chrome.runtime.sendMessage({
        type: "GET_PAGE_CONTEXT",
        tabId: sessionTab.tabId,
      }) as PageContextResponse;
      if (!contextResponse.ok) {
        throw new Error(contextResponse.error);
      }

      setTab(sessionTab);
      setPage(contextResponse.page ?? undefined);
      setActive(true);
      addEntry({
        kind: "system",
        text: contextResponse.page
          ? `Conversation page: “${contextResponse.page.title}”.`
          : "Conversation started in a new tab. Talk freely, or ask Astra to open a website.",
        status: "completed",
      });
      if (effective.controller) addEntry({ kind: "system", text: effective.controller.reason, status: "completed" });
      await session.start(sessionTab.tabId, contextResponse.page ?? undefined, configuration);
    } catch (cause) {
      await session.stop();
      setActive(false);
      const message = cause instanceof Error ? microphoneErrorMessage(cause) : "Could not start the session.";
      setError(message);
      setStatus("Ready");
      if (isMicrophonePermissionError(cause)) {
        await openMicrophoneSetup();
      }
    } finally {
      setStarting(false);
    }
  }

  async function openMicrophoneSetup(): Promise<void> {
    try {
      await chrome.runtime.openOptionsPage();
    } catch (cause) {
      setError(`Could not open microphone setup: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function copyDiagnostics(): Promise<void> {
    try {
      await navigator.clipboard.writeText(session.exportDiagnostics());
      setDiagnosticNotice("Copied protocol metadata only.");
    } catch (cause) {
      setError(`Could not copy diagnostics: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async function refreshPage(): Promise<void> {
    if (!tab) {
      return;
    }
    try {
      const response = await chrome.runtime.sendMessage({
        type: "GET_PAGE_CONTEXT",
        tabId: tab.tabId,
      }) as PageContextResponse;
      if (!response.ok) {
        throw new Error(response.error);
      }
      session.updatePage(response.page ?? undefined);
      addEntry({ kind: "system", text: response.page ? "Page context refreshed." : "No website is open yet. You can keep talking.", status: "completed" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function highlight(citationId: string): Promise<void> {
    if (!tab) {
      return;
    }
    await chrome.runtime.sendMessage({
      type: "EXECUTE_ACTION",
      tabId: tab.tabId,
      action: { name: "highlight", arguments: { citationId } },
    });
  }

  async function bookmark(entry: TimelineEntry): Promise<void> {
    const stored = await chrome.storage.local.get("bookmarks");
    const bookmarks = Array.isArray(stored.bookmarks) ? stored.bookmarks : [];
    await chrome.storage.local.set({
      bookmarks: [
        ...bookmarks,
        {
          text: entry.text,
          url: page?.url,
          title: page?.title,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  }

  async function resolveConfirmation(confirmed: boolean): Promise<void> {
    const confirmation = pending;
    setPending(undefined);
    if (confirmation) {
      await confirmation.complete(confirmed);
    }
  }

  if (configurationOpen) {
    return <ConfigurationPanel
      onClose={() => setConfigurationOpen(false)}
      onSaved={() => {
        setConfigurationOpen(false);
        setError("");
        addEntry({ kind: "system", text: "Configuration saved locally. Start a new conversation to use it.", status: "completed" });
      }}
    />;
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <div className="eyebrow">GPT-LIVE + ASTRA</div>
          <h1>Browse out loud.</h1>
        </div>
        <div className={`status ${active ? "status--active" : ""}`}>
          <span />
          {status}
        </div>
      </header>

      <section className="page-card">
        <div className="page-card__copy">
          <span>Conversation tab</span>
          <strong>{page?.title ?? tab?.title ?? "Start from any new tab or website"}</strong>
          <small>{page ? pageLabel(page) : tab ? "No website opened yet" : "No page connected"}</small>
        </div>
        <button className="icon-button" onClick={() => void refreshPage()} disabled={!active} title="Refresh page context">
          ↻
        </button>
      </section>

      <ActivityCard activity={activity} />

      <section className="timeline" ref={timelineRef} aria-live="polite">
        {entries.length === 0 ? (
          <div className="empty-state">
            <div className="orb">A</div>
            <h2>Read less. Understand more.</h2>
            <p>
              Activate from a new tab or website, then ask questions or tell Astra where to browse.
              References become clickable highlights on the page.
            </p>
          </div>
        ) : (
          entries.map((entry) => (
            <article className={`entry entry--${entry.kind} entry--${entry.status ?? "completed"}`} key={entry.id}>
              <div className="entry__meta">
                <span>{entry.kind === "assistant" ? "GPT Live" : entry.kind === "controller" ? "Astra · streamed answer" : entry.kind}</span>
                {entry.kind === "action" && (
                  <span>{entry.status === "pending" ? "In progress" : entry.status === "failed" ? "Not completed" : "Done"}
                    {entry.durationMs !== undefined && ` · ${(entry.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
                {(entry.kind === "assistant" || entry.kind === "controller") && (
                  <button onClick={() => void bookmark(entry)}>Save</button>
                )}
              </div>
              <p>{entry.text}</p>
              {mentionedCitations(entry.text, page).map((citation) => (
                <button
                  className="citation"
                  key={citation.id}
                  onClick={() => void highlight(citation.id)}
                >
                  {citation.id}
                </button>
              ))}
            </article>
          ))
        )}
      </section>

      {pending && (
        <section className="confirmation">
          <strong>Confirm irreversible action</strong>
          <p>{pending.summary}</p>
          <div>
            <button className="button button--ghost" onClick={() => void resolveConfirmation(false)}>
              Decline
            </button>
            <button className="button button--danger" onClick={() => void resolveConfirmation(true)}>
              Confirm
            </button>
          </div>
        </section>
      )}

      {error && <div className="error">{error}</div>}

      <footer className="controls">
        <button
          className={`talk-button ${active ? "talk-button--active" : ""}`}
          onClick={() => void toggleSession()}
          disabled={starting}
        >
          <span className="talk-button__icon">{active ? "■" : "●"}</span>
          <span>
            <strong>{starting ? "Connecting..." : active ? "Deactivate" : "Activate"}</strong>
            <small>{active ? "End open conversation" : "Start open conversation"}</small>
          </span>
        </button>
        <div className="utility-buttons">
          {taskBusy && <button className="button button--ghost" onClick={() => session.stopTask()}>
            Stop browser task
          </button>}
          <button className="button button--ghost" onClick={() => void openMicrophoneSetup()} disabled={active || starting}>
            Microphone setup
          </button>
          <button className="button button--ghost" onClick={() => setConfigurationOpen(true)} disabled={active || starting}
            title={active ? "Deactivate the conversation to change configuration" : "Configure your Foundry project and models"}>
            Configuration
          </button>
        </div>
        <div className="policy">Payments blocked · irreversible actions confirmed</div>
        <div className="session-meta">
          <small title={BUILD_ID}>Build {BUILD_ID.slice(0, 16).replace("T", " ")}</small>
          <button onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
        </div>
        {diagnosticNotice && <small className="diagnostic-notice" role="status">{diagnosticNotice}</small>}
      </footer>
    </main>
  );
}

function mentionedCitations(text: string, page?: PageContext) {
  if (!page) {
    return [];
  }
  return page.citations.filter((citation) => text.includes(citation.id));
}
