// Runtime for the installed companion. Installation copies this file into the per-user
// application directory, so it must only import Node.js built-ins.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const hostName = "com.chrome_gpt_live.companion";
export const companionUrl = "http://127.0.0.1:4317";
export const windowsRegistryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;
const hostDirectory = dirname(fileURLToPath(import.meta.url));

export function stateDirectory(platform = process.platform, environment = process.env, home = homedir()) {
  if (platform === "win32") return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "chrome-gpt-live");
  if (platform === "darwin") return join(home, "Library", "Application Support", "chrome-gpt-live");
  return join(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "chrome-gpt-live");
}

export function chromeManifestDirectory(platform = process.platform, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  if (platform === "win32") return undefined;
  return join(home, ".config", "google-chrome", "NativeMessagingHosts");
}

export function runQuiet(executable, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code) => resolveRun(code));
  });
}

export async function waitForCompanion({
  url = companionUrl,
  timeoutMs = 20_000,
  signal,
  request = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await request(`${url}/health`, {
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
          ...(signal ? [signal] : []),
        ]),
      });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof TypeError) && error.name !== "TimeoutError") throw error;
      lastError = error;
    }
    if (response) {
      if (!response.ok) throw new Error(`Companion health check failed (HTTP ${response.status}).`);
      const health = await response.json();
      if (health?.ok !== true || health.service !== "chrome-gpt-live") {
        throw new Error(`An unexpected service answered at ${url}. Resolve the port conflict before continuing.`);
      }
      return;
    }
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`The companion did not become ready at ${url}.`, { cause: lastError });
}

export async function companionHealth(request = fetch) {
  try {
    const response = await request(`${companionUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(1500) });
    const health = response.ok ? await response.json() : undefined;
    return health?.ok === true && health.service === "chrome-gpt-live" ? health : undefined;
  } catch {
    return undefined;
  }
}

export function launchCompanion(directory = hostDirectory) {
  const server = join(directory, "companion.mjs");
  if (!existsSync(server)) {
    throw new Error(`The companion is not installed in ${directory}. Run npm run setup from the Chrome GPT Live repository.`);
  }
  mkdirSync(directory, { recursive: true });
  const log = join(directory, "companion.log");
  const output = openSync(log, "w");
  const child = spawn(process.execPath, [server], {
    cwd: directory,
    // The extension has a fixed loopback endpoint; local startup must not use managed identity.
    env: { ...process.env, HOST: "127.0.0.1", PORT: "4317", NODE_ENV: "development" },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", output, output],
  });
  closeSync(output);
  const exited = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit(error.message));
    child.once("exit", (code, signal) => resolveExit(signal ?? code));
  });
  child.unref();
  return { log, exited };
}

export async function ensureCompanion({
  directory = hostDirectory,
  health = companionHealth,
  launch = () => launchCompanion(directory),
  waitUntilReady = waitForCompanion,
} = {}) {
  if (await health()) return { ok: true, status: "running" };
  let companion;
  try {
    companion = launch();
    await Promise.race([
      waitUntilReady({ timeoutMs: 30_000 }),
      companion.exited.then(async (code) => {
        // Another launcher may have won the port; that companion is equally valid.
        if (!await health()) throw new Error(`The companion exited (${code}) before becoming ready.`);
      }),
    ]);
    return { ok: true, status: "started" };
  } catch (error) {
    return { ok: false, error: companion ? `${error.message} See ${companion.log}.` : error.message };
  }
}

export async function stopCompanion({ request = fetch, kill = process.kill, timeoutMs = 5000 } = {}) {
  const health = await companionHealth(request);
  if (!health) return "The companion is not running.";
  if (!Number.isInteger(health.pid)) throw new Error("The running companion does not report its process ID. Stop it in its terminal.");
  kill(health.pid);
  const deadline = Date.now() + timeoutMs;
  while (await companionHealth(request)) {
    if (Date.now() > deadline) throw new Error(`Companion process ${health.pid} did not stop.`);
    await delay(100);
  }
  return `Stopped the companion (process ${health.pid}).`;
}

export async function unregisterHost({ platform = process.platform, run = runQuiet } = {}) {
  if (platform === "win32") await run("reg.exe", ["delete", windowsRegistryKey, "/f"]);
  else rmSync(join(chromeManifestDirectory(platform), `${hostName}.json`), { force: true });
}

export async function uninstallCompanion({ directory = stateDirectory(), stop = stopCompanion, unregister = unregisterHost } = {}) {
  await stop();
  await unregister();
  rmSync(directory, { recursive: true, force: true });
}

export function readNativeMessage(buffer) {
  if (buffer.length < 4) return undefined;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return undefined;
  return JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
}

export function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function serveNativeMessage() {
  let buffer = Buffer.alloc(0);
  let message;
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    message = readNativeMessage(buffer);
    if (message) break;
  }
  const reply = message?.type === "start"
    ? await ensureCompanion()
    : { ok: false, error: "Unsupported native host request." };
  await new Promise((resolveWrite) => process.stdout.write(encodeNativeMessage(reply), resolveWrite));
  process.exit(0);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command] = process.argv.slice(2);
  try {
    if (command?.startsWith("chrome-extension://")) {
      await serveNativeMessage();
    } else if (command === "start") {
      const result = await ensureCompanion();
      if (!result.ok) throw new Error(result.error);
      console.log(`The companion is ${result.status} at ${companionUrl}.`);
    } else if (command === "stop") {
      console.log(await stopCompanion());
    } else if (command === "uninstall") {
      await uninstallCompanion();
      console.log("Removed Chrome GPT Live's companion. Remove the extension at chrome://extensions.");
    } else {
      throw new Error("Usage: node native-host.mjs start|stop|uninstall");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
