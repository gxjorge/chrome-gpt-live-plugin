// Installs a self-contained copy of Chrome GPT Live into the per-user application directory,
// so the extension and its companion keep working if this repository is moved or deleted.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  chromeManifestDirectory,
  hostName,
  runQuiet,
  stateDirectory,
  stopCompanion,
  uninstallCompanion,
  windowsRegistryKey,
} from "./companion-host.mjs";

export { hostName, stateDirectory } from "./companion-host.mjs";

const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
export const builtExtensionDirectory = join(repositoryDirectory, "apps", "extension", "dist");

export function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((character) => String.fromCharCode(97 + Number.parseInt(character, 16))).join("");
}

export function extensionId() {
  const { key } = JSON.parse(readFileSync(join(repositoryDirectory, "apps", "extension", "extension-key.json"), "utf8"));
  return extensionIdFromKey(key);
}

export function hostManifest(launcherPath, id) {
  return {
    name: hostName,
    description: "Starts the Chrome GPT Live local companion on demand.",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  };
}

export function launcherScript(platform, nodePath, script) {
  return platform === "win32"
    ? `@echo off\r\n"${nodePath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec "${nodePath}" "${script}" "$@"\n`;
}

export async function bundleCompanion(outfile) {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [join(repositoryDirectory, "apps", "server", "src", "index.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "warning",
    // Bundled CommonJS dependencies expect these module globals.
    banner: {
      js: [
        'import { createRequire as __createRequire } from "node:module";',
        'import { fileURLToPath as __fileURLToPath } from "node:url";',
        'import { dirname as __pathDirname } from "node:path";',
        "const require = __createRequire(import.meta.url);",
        "const __filename = __fileURLToPath(import.meta.url);",
        "const __dirname = __pathDirname(__filename);",
      ].join("\n"),
    },
  });
}

export async function installCompanion({
  platform = process.platform,
  directory = stateDirectory(platform),
  source = builtExtensionDirectory,
  environmentFile = join(repositoryDirectory, "apps", "server", ".env"),
  nodePath = process.execPath,
  run = runQuiet,
  stop = stopCompanion,
  bundle = bundleCompanion,
} = {}) {
  if (!existsSync(join(source, "manifest.json"))) {
    throw new Error("The extension is not built. Run npm run build first.");
  }
  // A running companion would keep serving the previous version.
  await stop();
  mkdirSync(directory, { recursive: true });

  const extensionDirectory = join(directory, "extension");
  rmSync(extensionDirectory, { recursive: true, force: true });
  cpSync(source, extensionDirectory, { recursive: true });
  await bundle(join(directory, "companion.mjs"));
  const hostScript = join(directory, "native-host.mjs");
  copyFileSync(fileURLToPath(new URL("./companion-host.mjs", import.meta.url)), hostScript);
  if (existsSync(environmentFile)) copyFileSync(environmentFile, join(directory, ".env"));

  const launcher = join(directory, platform === "win32" ? "native-host.cmd" : "native-host.sh");
  writeFileSync(launcher, launcherScript(platform, nodePath, hostScript));
  if (platform !== "win32") chmodSync(launcher, 0o755);
  const manifest = JSON.stringify(hostManifest(launcher, extensionId()), null, 2);
  let manifestPath;
  if (platform === "win32") {
    manifestPath = join(directory, `${hostName}.json`);
    writeFileSync(manifestPath, manifest);
    if (await run("reg.exe", ["add", windowsRegistryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]) !== 0) {
      throw new Error(`Could not register the native messaging host in ${windowsRegistryKey}.`);
    }
  } else {
    const manifestDirectory = chromeManifestDirectory(platform);
    mkdirSync(manifestDirectory, { recursive: true });
    manifestPath = join(manifestDirectory, `${hostName}.json`);
    writeFileSync(manifestPath, manifest);
  }
  return { directory, extensionDirectory, manifestPath };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command] = process.argv.slice(2);
  try {
    if (command === "install") {
      const { directory, extensionDirectory } = await installCompanion();
      console.log(`Installed Chrome GPT Live in ${directory}`);
      console.log(`Load or reload the unpacked extension from ${extensionDirectory} at chrome://extensions.`);
    } else if (command === "uninstall") {
      await uninstallCompanion();
      console.log("Removed Chrome GPT Live's companion. Remove the extension at chrome://extensions.");
    } else if (command === "stop") {
      console.log(await stopCompanion());
    } else {
      throw new Error("Usage: node scripts/native-host.mjs install|uninstall|stop");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
