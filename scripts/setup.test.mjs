import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCompanionPort,
  checkNodeVersion,
  checkSetupPort,
  commandInvocation,
  confirm,
  extensionDirectory,
  runSetup,
  waitForCompanion,
} from "./setup.mjs";
import { startLocalCompanion } from "./start.mjs";

function setupFixture({ answers = [], resultFor = () => 0, startResult = { ok: true, status: "started" }, openError, installError } = {}) {
  const events = [];
  const output = [];
  const options = {
    nodeVersion: "24.0.0",
    ask: async (message) => {
      events.push(["ask", message]);
      return answers.shift() ?? "";
    },
    log: (message) => output.push(message),
    checkPort: async () => events.push(["port"]),
    install: async () => {
      events.push(["install"]);
      if (installError) throw installError;
    },
    run: async (command, args, options) => {
      events.push([command, args, options]);
      return resultFor(command, args);
    },
    openPages: async () => {
      events.push(["open"]);
      if (openError) throw openError;
    },
    start: async () => {
      events.push(["start"]);
      return startResult;
    },
  };
  return { events, output, options };
}

test("requires a Node version supported by the build dependencies", () => {
  for (const version of ["22.12.0", "22.20.0", "24.0.0", "25.0.0"]) {
    assert.doesNotThrow(() => checkNodeVersion(version));
  }
  for (const version of ["20.19.0", "22.0.0", "22.11.9", "23.11.0", "invalid"]) {
    assert.throws(() => checkNodeVersion(version), /Install Node.js 22.12/);
  }
});

test("local startup loads server .env from its workspace and pins loopback and local authentication", async () => {
  const cwd = process.cwd();
  const variables = ["HOST", "PORT", "NODE_ENV", "FOUNDRY_PROJECT_ENDPOINT"];
  const previous = Object.fromEntries(variables.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      HOST: "0.0.0.0", PORT: "9999", NODE_ENV: "production",
      FOUNDRY_PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/example",
    });
    let loaded = false;
    await startLocalCompanion(async () => {
      loaded = true;
      assert.equal(process.cwd(), fileURLToPath(new URL("../apps/server/", import.meta.url)).replace(/[\\/]$/, ""));
      assert.equal(process.env.HOST, "127.0.0.1");
      assert.equal(process.env.PORT, "4317");
      assert.equal(process.env.NODE_ENV, "development");
      assert.equal(process.env.FOUNDRY_PROJECT_ENDPOINT, "https://example.services.ai.azure.com/api/projects/example");
    });
    assert.equal(loaded, true);
  } finally {
    process.chdir(cwd);
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("yes/no prompts accept defaults and retry invalid answers", async () => {
  const answers = ["maybe", " YES "];
  let prompts = 0;
  assert.equal(await confirm(async () => {
    prompts++;
    return answers.shift();
  }, "Continue?"), true);
  assert.equal(prompts, 2);
  assert.equal(await confirm(async () => "", "Continue?"), true);
  assert.equal(await confirm(async () => "n", "Continue?"), false);
});

test("uses the current npm CLI directly, including a path with spaces", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(commandInvocation("npm", ["ci"], "win32", { npm_execpath: npmCli }), [
    process.execPath, [npmCli, "ci"],
  ]);
});

test("uses the Windows command launcher for Azure CLI and direct commands elsewhere", () => {
  assert.deepEqual(commandInvocation("az", ["version", "--output", "none"], "win32", { ComSpec: "cmd.exe" }), [
    "cmd.exe", ["/d", "/s", "/c", "az version --output none"],
  ]);
  assert.deepEqual(commandInvocation("az", ["login"], "linux", {}), ["az", ["login"]]);
});

test("help works without dependencies or an interactive terminal", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./setup.mjs", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /Usage: npm run setup/);
  assert.match(child.stdout, /Update: rerun npm run setup/);
});

test("rejects noninteractive setup rather than implicitly approving installation", () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./setup.mjs", import.meta.url))], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /interactive terminal/);
  assert.doesNotMatch(child.stdout, /Installing dependencies/);
});

test("checks authentication, builds, installs outside the repository, starts the companion, then opens Chrome", async () => {
  const fixture = setupFixture();
  await runSetup(fixture.options);
  const commands = fixture.events.filter(([command]) => command === "npm" || command === "az");
  assert.deepEqual(commands.map(([command, args]) => [command, args]), [
    ["az", ["version", "--output", "none"]],
    ["az", ["account", "get-access-token", "--scope", "https://cognitiveservices.azure.com/.default", "--output", "none"]],
    ["npm", ["ci", "--include=dev", "--no-audit", "--no-fund"]],
    ["npm", ["run", "build"]],
  ]);
  assert.deepEqual(fixture.events.filter(([event]) => ["install", "start", "open"].includes(event))
    .map(([event]) => event), ["install", "start", "open"]);
  const output = fixture.output.join("\n");
  assert.match(output, /running in the background/);
  assert.match(output, /repository is no longer needed/);
  assert.ok(output.includes(extensionDirectory));
  assert.ok(!extensionDirectory.startsWith(fileURLToPath(new URL("../", import.meta.url))));
  assert.match(output, /Load unpacked/);
  assert.match(output, /Microphone setup/);
});

test("requests sign-in only if a usable Cognitive Services token is missing", async () => {
  let tokenRequests = 0;
  const fixture = setupFixture({
    resultFor: (command, args) => command === "az" && args[0] === "account" && tokenRequests++ === 0 ? 1 : 0,
  });
  await runSetup(fixture.options);
  assert.equal(tokenRequests, 2);
  assert.ok(fixture.events.some(([command, args]) => command === "az" && args[0] === "login" && args.at(-1) === "none"));
});

test("missing prerequisites, declined consent, and failed sign-in never install or start anything", async () => {
  for (const [fixture, message] of [
    [setupFixture({ resultFor: () => 1 }), /Install it/],
    [setupFixture({ answers: ["n"] }), /Setup cancelled/],
    [setupFixture({ answers: ["y", "n"], resultFor: (_, args) => args[0] === "account" ? 1 : 0 }), /az login/],
    [setupFixture({ resultFor: (_, args) => ["account", "login"].includes(args[0]) ? 1 : 0 }), /sign-in did not provide/],
  ]) {
    await assert.rejects(runSetup(fixture.options), message);
    assert.ok(!fixture.events.some(([event]) => ["npm", "install", "start"].includes(event)));
  }
});

test("a port conflict stops setup before Azure sign-in or dependency installation", async () => {
  const fixture = setupFixture();
  fixture.options.checkPort = async () => { throw new Error("Port conflict"); };
  await assert.rejects(runSetup(fixture.options), /Port conflict/);
  assert.ok(!fixture.events.some(([event]) => event === "az" || event === "npm" || event === "start"));
});

test("an installed companion on the port is replaced, but an unrelated listener is a conflict", async () => {
  const conflict = async () => { throw new Error("Port conflict"); };
  await checkSetupPort({ checkPort: conflict, health: async () => ({ ok: true }) });
  await assert.rejects(checkSetupPort({ checkPort: conflict, health: async () => undefined }), /Port conflict/);
});

test("installation failures stop setup before starting the companion", async () => {
  const fixture = setupFixture({ installError: new Error("Registry unavailable") });
  await assert.rejects(runSetup(fixture.options), /Installation failed: Registry unavailable/);
  assert.ok(!fixture.events.some(([event]) => event === "start" || event === "open"));
});

test("dependency and build failures prevent installation", async () => {
  for (const failedOperation of ["ci", "run"]) {
    const fixture = setupFixture({ resultFor: (command, args) => command === "npm" && args[0] === failedOperation ? 1 : 0 });
    await assert.rejects(runSetup(fixture.options), failedOperation === "ci" ? /installation failed/ : /build failed/);
    assert.ok(!fixture.events.some(([event]) => event === "install" || event === "start"));
    if (failedOperation === "ci") {
      assert.ok(!fixture.events.some(([event, args]) => event === "npm" && args[0] === "run"));
    }
  }
});

test("failed startup is reported with its log and never claims success", async () => {
  const fixture = setupFixture({ startResult: { ok: false, error: "Startup failed. See companion.log." } });
  await assert.rejects(runSetup(fixture.options), /did not start: Startup failed\. See companion\.log/);
  assert.ok(!fixture.events.some(([event]) => event === "open"));
  assert.doesNotMatch(fixture.output.join("\n"), /Installed\./);
});

test("manual opening is honored and optional opening failures are explained", async () => {
  const manual = setupFixture({ answers: ["y", "n"] });
  await runSetup(manual.options);
  assert.ok(!manual.events.some(([event]) => event === "open"));
  const failedOpen = setupFixture({ openError: new Error("Chrome not found") });
  await runSetup(failedOpen.options);
  assert.match(failedOpen.output.join("\n"), /Automatic opening failed: Chrome not found/);
});

test("health checks verify the actual service identity", async (context) => {
  const server = createServer((_, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, service: "chrome-gpt-live" }));
  });
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  context.after(() => new Promise((resolveClose) => {
    server.closeAllConnections();
    server.close(resolveClose);
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  await waitForCompanion({ url });
  await assert.rejects(waitForCompanion({ request: async () => Response.json({ ok: true }) }), /unexpected service/);
  await assert.rejects(waitForCompanion({ request: async () => new Response("", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(waitForCompanion({ request: async () => new Response("not json") }), SyntaxError);
});

test("readiness retries connection failures, bounds its wait, and supports cancellation", async () => {
  let attempts = 0;
  await waitForCompanion({
    request: async () => {
      if (++attempts === 1) throw new TypeError("Connection refused");
      return Response.json({ ok: true, service: "chrome-gpt-live" });
    },
    timeoutMs: 1000,
  });
  assert.equal(attempts, 2);
  const started = Date.now();
  await assert.rejects(waitForCompanion({
    request: async () => { throw new TypeError("Connection refused"); },
    timeoutMs: 30,
  }), /did not become ready/);
  assert.ok(Date.now() - started < 500);
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await assert.rejects(waitForCompanion({ signal: controller.signal }), /Cancelled/);
});

test("an occupied companion port produces actionable guidance without stopping its owner", async (context) => {
  const server = createTcpServer();
  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  await assert.rejects(checkCompanionPort(server.address().port), /Stop an existing companion/);
  assert.equal(server.listening, true);
});
