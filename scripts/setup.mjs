import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { companionHealth, companionUrl, ensureCompanion, stateDirectory } from "./companion-host.mjs";

export { companionUrl, waitForCompanion } from "./companion-host.mjs";
export const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
export const installDirectory = stateDirectory();
export const extensionDirectory = join(installDirectory, "extension");
const azureInstallUrl = "https://learn.microsoft.com/cli/azure/install-azure-cli";
const nodeInstallUrl = "https://nodejs.org/en/download";

export function checkNodeVersion(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (!(major >= 24 || (major === 22 && minor >= 12))) {
    throw new Error(`Node.js ${version} is unsupported. Install Node.js 22.12+ or 24+: ${nodeInstallUrl}`);
  }
}

export async function confirm(ask, message) {
  while (true) {
    const answer = (await ask(`${message} [Y/n] `)).trim().toLowerCase();
    if (!answer || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
  }
}

export function checkCompanionPort(port = 4317) {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", (error) => reject(new Error(
      `Cannot use http://127.0.0.1:${port}. Stop an existing companion (npm run stop, or Ctrl+C in its terminal), or resolve the port conflict, then rerun npm run setup. (${error.message})`,
      { cause: error },
    )));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolvePort());
    });
  });
}

// Setup replaces an installed companion, so only an unrelated listener is a conflict.
export async function checkSetupPort({ checkPort = checkCompanionPort, health = companionHealth } = {}) {
  try {
    await checkPort();
  } catch (error) {
    if (!await health()) throw error;
  }
}

export function commandInvocation(command, args, platform = process.platform, environment = process.env) {
  if (command === "npm" && environment.npm_execpath) {
    return [process.execPath, [environment.npm_execpath, ...args]];
  }
  // Azure CLI and npm use .cmd launchers on Windows. Arguments here are fixed, never user input.
  if (platform === "win32") {
    return [environment.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [command, ...args].join(" ")]];
  }
  return [command, args];
}

export function runCommand(command, args, { quiet = false } = {}) {
  const [executable, argumentsList] = commandInvocation(command, args);
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd: repositoryDirectory,
      stdio: quiet ? "ignore" : "inherit",
    });
    child.once("error", (error) => reject(new Error(
      `Could not run ${command}: ${error.message}${command === "az" ? `\nInstall Azure CLI, reopen your terminal, and rerun setup: ${azureInstallUrl}` : ""}`,
      { cause: error },
    )));
    child.once("close", (code, signal) => {
      if (signal) reject(new Error(`${command} was interrupted (${signal}).`));
      else resolveCommand(code);
    });
  });
}

function launch(executable, args) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch();
    });
  });
}

export async function openInstallPages() {
  if (process.platform === "win32") {
    await launch("explorer.exe", [extensionDirectory]);
    const chrome = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean).map((directory) => join(directory, "Google", "Chrome", "Application", "chrome.exe"))
      .find((file) => existsSync(file));
    if (!chrome) throw new Error("Chrome was not found in its usual install locations. Open chrome://extensions manually.");
    await launch(chrome, ["chrome://extensions"]);
  } else if (process.platform === "darwin") {
    if (await runCommand("open", [extensionDirectory]) !== 0 ||
        await runCommand("open", ["-a", "Google Chrome", "chrome://extensions"]) !== 0) {
      throw new Error("Could not open the installation pages. Open Chrome and the extension folder manually.");
    }
  } else {
    throw new Error("Automatic opening is available on Windows and macOS. Open Chrome and the extension folder manually.");
  }
}

export async function runSetup({
  ask,
  log = console.log,
  run = runCommand,
  checkPort = checkSetupPort,
  install = async () => (await import("./native-host.mjs")).installCompanion(),
  start = ensureCompanion,
  openPages = openInstallPages,
  nodeVersion = process.versions.node,
} = {}) {
  checkNodeVersion(nodeVersion);
  log("\nChrome GPT Live guided installation\n");
  log("1/4 Checking Node.js, Azure CLI, and the local companion port.");
  await checkPort();
  if (await run("az", ["version", "--output", "none"], { quiet: true }) !== 0) {
    throw new Error(`Azure CLI is missing or could not run. Install it, reopen your terminal, and rerun setup: ${azureInstallUrl}`);
  }
  if (!await confirm(ask, `Install locked dependencies, build, and install Chrome GPT Live in ${installDirectory}?`)) {
    throw new Error("Setup cancelled. No dependencies or builds were changed.");
  }

  log("\n2/4 Checking Azure sign-in. No credentials are written to this repository.");
  const tokenArgs = ["account", "get-access-token", "--scope", "https://cognitiveservices.azure.com/.default", "--output", "none"];
  if (await run("az", tokenArgs, { quiet: true }) !== 0) {
    if (!await confirm(ask, "Azure sign-in is needed. Open Azure CLI's browser sign-in now?")) {
      throw new Error("Sign in with az login, then rerun npm run setup.");
    }
    if (await run("az", ["login", "--output", "none"]) !== 0 ||
        await run("az", tokenArgs) !== 0) {
      throw new Error("Azure sign-in did not provide a Cognitive Services token. Resolve the Azure CLI error above and rerun setup.");
    }
  }
  log("Azure CLI sign-in is ready. Foundry resource permissions and deployments are still required.");
  const openAutomatically = await confirm(ask, "Open Chrome's extensions page and the extension folder after installing?");

  log("\n3/4 Installing dependencies and building. Existing .env and Chrome settings are preserved.");
  if (await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]) !== 0) {
    throw new Error("Dependency installation failed. Resolve the npm error above and rerun npm run setup.");
  }
  if (await run("npm", ["run", "build"]) !== 0) {
    throw new Error("The build failed. Resolve the build error above and rerun npm run setup.");
  }

  log(`\n4/4 Installing Chrome GPT Live in ${installDirectory} and starting the companion.`);
  try {
    await install();
  } catch (error) {
    throw new Error(`Installation failed: ${error.message}`, { cause: error });
  }
  const companion = await start();
  if (!companion.ok) throw new Error(`The installed companion did not start: ${companion.error}`);
  log(`\nInstalled. The companion is running in the background at ${companionUrl}.
Chrome GPT Live starts it automatically whenever you open the side panel, so this
repository is no longer needed to use the extension.

Finish these steps in Chrome:
  1. Open chrome://extensions and enable Developer mode.
  2. If an older Chrome GPT Live loaded from this repository is listed, click Remove.
  3. Click Load unpacked and select this folder:
     ${extensionDirectory}
     If it is already loaded from there, click Reload on its card instead.
  4. Open Chrome GPT Live from Chrome's Extensions menu; pin it for easier access.
  5. In Configuration, enter your Foundry project endpoint and deployment names, then Save configuration.
  6. Click Microphone setup, allow access in the new tab, then return and Activate.

Chrome requires you to approve loading an unpacked extension and microphone access.
To update later, pull the repository and rerun npm run setup, then click Reload in Chrome.
Guide: https://github.com/gxjorge/chrome-gpt-live-plugin#setup
`);
  if (openAutomatically) {
    try {
      await openPages();
    } catch (error) {
      log(`Automatic opening failed: ${error.message}\nUse the folder and Chrome instructions above.`);
    }
  }
}

async function askQuestion(message) {
  const controller = new AbortController();
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  readline.once("SIGINT", () => controller.abort(new Error("Setup cancelled.")));
  readline.once("close", () => controller.abort(new Error("Setup input closed.")));
  try {
    return await readline.question(message, { signal: controller.signal });
  } finally {
    readline.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") {
      console.log(`Usage: npm run setup

Interactive setup checks prerequisites and Azure sign-in, installs dependencies,
builds, and installs a self-contained copy of the extension and its companion in
${installDirectory}
Chrome GPT Live then starts the companion automatically; the repository is not needed.
Requires Node.js 22.12+ or 24+, Azure CLI, and Chrome 116+.
Node.js: ${nodeInstallUrl}
Azure CLI: ${azureInstallUrl}
Update: rerun npm run setup. Stop the companion: npm run stop. Remove: npm run companion:uninstall`);
    } else {
      if (args.length) throw new Error("Unknown setup arguments. Use npm run setup -- --help.");
      if (!process.stdin.isTTY) throw new Error("Run npm run setup in an interactive terminal. For help, use npm run setup -- --help.");
      await runSetup({ ask: askQuestion });
    }
  } catch (error) {
    console.error(`\nSetup stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
