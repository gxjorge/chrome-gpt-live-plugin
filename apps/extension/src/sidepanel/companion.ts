export const COMPANION_URL = "http://127.0.0.1:4317";
export const NATIVE_HOST = "com.chrome_gpt_live.companion";
const START_TIMEOUT_MS = 45_000;

export const COMPANION_SETUP_HELP =
  "The local companion is not installed or could not be started automatically. " +
  "Run npm run setup from the Chrome GPT Live repository, then load or reload the extension from the folder it prints at chrome://extensions.";

let starting: Promise<boolean> | undefined;

async function isHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${COMPANION_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const health = await response.json() as { ok?: unknown; service?: unknown };
    return health.ok === true && health.service === "chrome-gpt-live";
  } catch {
    return false;
  }
}

async function launchWithNativeHost(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendNativeMessage) {
    throw new Error(COMPANION_SETUP_HELP);
  }
  let reply: { ok?: boolean; error?: string } | undefined;
  try {
    reply = await Promise.race([
      chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: "start" }) as Promise<typeof reply>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for the companion to start.")), START_TIMEOUT_MS)),
    ]);
  } catch (error) {
    throw new Error(`${COMPANION_SETUP_HELP} (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (!reply?.ok) {
    throw new Error(`The local companion could not start: ${reply?.error ?? "no response from the native host."}`);
  }
}

/** Starts the companion if it is down. Resolves true when a start was needed. */
export function ensureCompanion(): Promise<boolean> {
  starting ??= (async () => {
    if (await isHealthy()) return false;
    await launchWithNativeHost();
    return true;
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function companionFetch(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
  const url = `${COMPANION_URL}${path}`;
  const attempt = () => {
    if (timeoutMs === undefined) return fetch(url, init);
    const timeout = AbortSignal.timeout(timeoutMs);
    return fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
  try {
    return await attempt();
  } catch (error) {
    // Network failures surface as TypeError ("Failed to fetch"); aborts and timeouts are not retried.
    if (!(error instanceof TypeError) || init.signal?.aborted) throw error;
    if (!await ensureCompanion()) throw error;
    init.signal?.throwIfAborted();
    return attempt();
  }
}
