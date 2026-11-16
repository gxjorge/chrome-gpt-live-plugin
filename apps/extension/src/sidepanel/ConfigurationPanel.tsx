import { useEffect, useState, type FormEvent } from "react";
import {
  DEFAULT_ASTRA_DEPLOYMENT,
  DEFAULT_LIVE_DEPLOYMENT,
  foundryConfigurationSchema,
  type ResolvedFoundryConfiguration,
} from "@chrome-gpt-live/shared";
import {
  clearFoundryConfiguration,
  loadFoundryConfiguration,
  resolveFoundryConfiguration,
  saveFoundryConfiguration,
} from "./configuration";

const fields = [
  { name: "projectEndpoint", label: "Foundry project endpoint", placeholder: "https://your-resource.services.ai.azure.com/api/projects/your-project", type: "url" },
  { name: "liveDeployment", label: "Live model deployment", placeholder: "your-live-deployment", type: "text" },
  { name: "astraDeployment", label: "Astra / controller deployment", placeholder: "your-astra-deployment", type: "text" },
  { name: "decisionDeployment", label: "Fast decision deployment (MD-1, optional)", placeholder: "leave blank to disable", type: "text" },
] as const;

type Draft = Record<typeof fields[number]["name"], string>;
const emptyDraft: Draft = { projectEndpoint: "", liveDeployment: DEFAULT_LIVE_DEPLOYMENT, astraDeployment: DEFAULT_ASTRA_DEPLOYMENT, decisionDeployment: "" };

export function ConfigurationPanel({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [resolved, setResolved] = useState<ResolvedFoundryConfiguration>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [browserControl, setBrowserControl] = useState<"astra" | "md1-first">("astra");

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const saved = await loadFoundryConfiguration();
        const effective = await resolveFoundryConfiguration(saved);
        if (current) {
          setDraft({
            projectEndpoint: saved.projectEndpoint ?? emptyDraft.projectEndpoint,
            liveDeployment: saved.liveDeployment ?? emptyDraft.liveDeployment,
            astraDeployment: saved.astraDeployment ?? emptyDraft.astraDeployment,
            decisionDeployment: saved.decisionDeployment ?? emptyDraft.decisionDeployment,
          });
          setResolved(effective);
          setBrowserControl(saved.browserControl ?? "astra");
        }
      } catch (cause) {
        if (current) {
          setResolved(undefined);
          setError(`Could not load configuration. ${errorMessage(cause)}`);
        }
      } finally {
        if (current) {
          setLoading(false);
        }
      }
    })();
    return () => { current = false; };
  }, [revision]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const values = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
      const parsed = foundryConfigurationSchema.safeParse({ ...values, ...(browserControl === "md1-first" ? { browserControl } : {}) });
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
      }
      const configuration = parsed.data;
      const effective = await resolveFoundryConfiguration(configuration);
      if (!effective.ready) {
        throw new Error("Enter a Foundry project endpoint or set FOUNDRY_PROJECT_ENDPOINT in the companion's .env file.");
      }
      await saveFoundryConfiguration(configuration);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try {
      await clearFoundryConfiguration();
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(`Could not clear saved configuration: ${errorMessage(cause)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="shell">
      <header className="header">
        <div>
          <div className="eyebrow">CONNECTION SETUP</div>
          <h1>Your Foundry.</h1>
        </div>
        <button className="button button--ghost" onClick={onClose} disabled={saving}>Back</button>
      </header>
      <section className="settings-priority">
        <strong>Environment first.</strong>
        <p>Non-empty .env or environment values override saved settings. Locked fields show what the companion will use.</p>
      </section>
      <form className="settings-form" onSubmit={(event) => void save(event)}>
        <div className="settings-fields">
          <p className="settings-help">Use your Foundry project URL and deployment names, which can differ from model IDs. Settings stay in this Chrome profile.</p>
          {loading && <p role="status">Reading companion configuration...</p>}
          {fields.map((field) => {
            const locked = resolved?.overrides[field.name] ?? false;
            return (
              <label className="settings-field" key={field.name} htmlFor={`setting-${field.name}`}>
                <span>{field.label}</span>
                {locked && <small>Managed by .env / environment</small>}
                <input
                  id={`setting-${field.name}`}
                  type={field.type}
                  value={locked ? resolved?.values[field.name] ?? "" : draft[field.name]}
                  onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}
                  placeholder={field.placeholder}
                  required={!locked && field.name !== "decisionDeployment"}
                  readOnly={locked}
                  disabled={loading || saving || !resolved}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            );
          })}
          {resolved?.overrides.openAIEndpoint && (
            <p className="settings-help">GPT-Live resource, managed by environment:<br /><code>{resolved.values.openAIEndpoint}</code></p>
          )}
          <label className="settings-field">
            <span>Experimental browser controller</span>
            <select value={resolved?.overrides.browserControl ? resolved.values.browserControl : browserControl}
              disabled={loading || saving || !resolved || resolved.overrides.browserControl}
              onChange={(event) => setBrowserControl(event.target.value === "md1-first" ? "md1-first" : "astra")}>
              <option value="astra">Managed Astra (default)</option>
              <option value="md1-first">MD-1 first, with Astra fallback</option>
            </select>
            <small>{resolved?.controller?.reason ?? "Managed Astra (default)."}</small>
            <small>MD-1-first requires a decision deployment and the companion's protocol-verification release lock. No latency improvement has been established.</small>
          </label>
          <p className="settings-help">The GPT-Live resource endpoint is derived from the project unless AZURE_OPENAI_ENDPOINT overrides it. Authentication stays on the companion: use <code>az login</code> locally or managed identity in Azure. No API keys are stored here.</p>
          {error && <div className="error" role="alert">{error}</div>}
          {!loading && !resolved && <button type="button" className="button button--ghost" onClick={() => setRevision((value) => value + 1)}>Retry</button>}
        </div>
        <footer className="settings-actions">
          <button className="button settings-save" type="submit" disabled={loading || saving || !resolved}>
            {saving ? "Saving..." : "Save configuration"}
          </button>
          <button className="button button--ghost" type="button" disabled={loading || saving} onClick={() => void reset()}>
            Clear saved settings
          </button>
          <small>Applies to new conversations. Environment values are never copied into saved settings.</small>
        </footer>
      </form>
    </main>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
