import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  encodeNativeMessage,
  ensureCompanion,
  readNativeMessage,
  stopCompanion,
  uninstallCompanion,
} from "./companion-host.mjs";
import {
  extensionId,
  hostManifest,
  hostName,
  installCompanion,
  launcherScript,
  stateDirectory,
} from "./native-host.mjs";

const keyFile = JSON.parse(readFileSync(new URL("../apps/extension/extension-key.json", import.meta.url), "utf8"));

test("derives the fixed unpacked extension ID from the committed manifest key", () => {
  assert.match(extensionId(), /^[a-p]{32}$/);
  assert.equal(extensionId(), keyFile.id);
});

test("the host manifest only allows the Chrome GPT Live extension", () => {
  const manifest = hostManifest("C:\\state\\native-host.cmd", "abcdefghijklmnopabcdefghijklmnop");
  assert.equal(manifest.name, hostName);
  assert.equal(manifest.type, "stdio");
  assert.deepEqual(manifest.allowed_origins, ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]);
});

test("launchers pin the installing Node.js and forward Chrome's arguments", () => {
  assert.equal(
    launcherScript("win32", "C:\\Program Files\\nodejs\\node.exe", "C:\\repo\\scripts\\native-host.mjs"),
    "@echo off\r\n\"C:\\Program Files\\nodejs\\node.exe\" \"C:\\repo\\scripts\\native-host.mjs\" %*\r\n",
  );
  assert.equal(launcherScript("linux", "/usr/bin/node", "/repo/native-host.mjs"), "#!/bin/sh\nexec \"/usr/bin/node\" \"/repo/native-host.mjs\" \"$@\"\n");
});

test("stores host files in per-user application data", () => {
  assert.equal(stateDirectory("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }), join("C:\\Users\\me\\AppData\\Local", "chrome-gpt-live"));
  assert.equal(stateDirectory("linux", {}, "/home/me"), join("/home/me", ".local", "state", "chrome-gpt-live"));
});

test("native messages use Chrome's length-prefixed JSON framing", () => {
  const encoded = encodeNativeMessage({ type: "start", note: "é" });
  assert.equal(encoded.readUInt32LE(0), encoded.length - 4);
  assert.deepEqual(readNativeMessage(encoded), { type: "start", note: "é" });
  assert.equal(readNativeMessage(encoded.subarray(0, 6)), undefined);
});

test("does not launch a second companion when one is already healthy", async () => {
  let launched = false;
  const result = await ensureCompanion({ health: async () => ({ ok: true }), launch: () => { launched = true; } });
  assert.deepEqual(result, { ok: true, status: "running" });
  assert.equal(launched, false);
});

test("launches the companion and reports readiness", async () => {
  const result = await ensureCompanion({
    health: async () => undefined,
    launch: () => ({ log: "companion.log", exited: new Promise(() => {}) }),
    waitUntilReady: async () => {},
  });
  assert.deepEqual(result, { ok: true, status: "started" });
});

test("accepts a concurrently launched companion and reports failures with the log path", async () => {
  let checks = 0;
  const raced = await ensureCompanion({
    health: async () => (checks++ === 0 ? undefined : { ok: true }),
    launch: () => ({ log: "companion.log", exited: Promise.resolve(1) }),
    waitUntilReady: () => new Promise(() => {}),
  });
  assert.deepEqual(raced, { ok: true, status: "started" });

  const failed = await ensureCompanion({
    health: async () => undefined,
    launch: () => ({ log: "C:\\state\\companion.log", exited: Promise.resolve(1) }),
    waitUntilReady: () => new Promise(() => {}),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /exited \(1\) before becoming ready\. See C:\\state\\companion\.log/);
});

test("the installed host runtime only depends on Node.js built-ins", () => {
  const source = readFileSync(new URL("./companion-host.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, specifier]) => specifier);
  assert.ok(imports.length > 0);
  assert.ok(imports.every((specifier) => specifier.startsWith("node:")), imports.join(", "));
});

test("installs a self-contained copy that does not reference the repository", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "chrome-gpt-live-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "dist");
  const directory = join(root, "app");
  mkdirSync(source);
  writeFileSync(join(source, "manifest.json"), "{}");
  writeFileSync(join(root, ".env"), "FOUNDRY_PROJECT_ENDPOINT=https://example\n");
  mkdirSync(join(directory, "extension"), { recursive: true });
  writeFileSync(join(directory, "extension", "stale.js"), "");
  const calls = [];
  const result = await installCompanion({
    platform: "win32",
    directory,
    source,
    environmentFile: join(root, ".env"),
    nodePath: "C:\\node\\node.exe",
    stop: async () => calls.push("stop"),
    bundle: async (outfile) => { calls.push("bundle"); writeFileSync(outfile, ""); },
    run: async (executable, args) => { calls.push([executable, args]); return 0; },
  });

  assert.equal(calls[0], "stop");
  assert.ok(existsSync(join(directory, "extension", "manifest.json")));
  assert.ok(!existsSync(join(directory, "extension", "stale.js")));
  assert.ok(existsSync(join(directory, "companion.mjs")));
  assert.equal(readFileSync(join(directory, "native-host.mjs"), "utf8"), readFileSync(new URL("./companion-host.mjs", import.meta.url), "utf8"));
  assert.match(readFileSync(join(directory, ".env"), "utf8"), /FOUNDRY_PROJECT_ENDPOINT/);
  assert.equal(readFileSync(join(directory, "native-host.cmd"), "utf8"), launcherScript("win32", "C:\\node\\node.exe", join(directory, "native-host.mjs")));
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.path, join(directory, "native-host.cmd"));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${keyFile.id}/`]);
  assert.deepEqual(calls.at(-1), ["reg.exe", ["add", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`, "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]]);
  assert.equal(result.extensionDirectory, join(directory, "extension"));
});

test("installation requires a built extension and leaves a running companion untouched", async () => {
  let stopped = false;
  await assert.rejects(installCompanion({ source: join(tmpdir(), "missing-chrome-gpt-live-dist"), stop: async () => { stopped = true; } }), /npm run build/);
  assert.equal(stopped, false);
});

test("reports a missing installation instead of launching nothing", async () => {
  const result = await ensureCompanion({ directory: join(tmpdir(), "missing-chrome-gpt-live"), health: async () => undefined });
  assert.equal(result.ok, false);
  assert.match(result.error, /not installed .* npm run setup/);
});

test("stopping waits until the companion no longer answers", async () => {
  let healthy = 3;
  const killed = [];
  const message = await stopCompanion({
    request: async () => healthy-- > 0 ? Response.json({ ok: true, service: "chrome-gpt-live", pid: 42 }) : Promise.reject(new TypeError("refused")),
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(killed, [42]);
  assert.match(message, /process 42/);
  assert.equal(await stopCompanion({ request: async () => { throw new TypeError("refused"); } }), "The companion is not running.");
});

test("uninstall stops the companion, unregisters Chrome, and removes the installed files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chrome-gpt-live-"));
  writeFileSync(join(directory, "companion.mjs"), "");
  const steps = [];
  await uninstallCompanion({ directory, stop: async () => steps.push("stop"), unregister: async () => steps.push("unregister") });
  assert.deepEqual(steps, ["stop", "unregister"]);
  assert.equal(existsSync(directory), false);
});
