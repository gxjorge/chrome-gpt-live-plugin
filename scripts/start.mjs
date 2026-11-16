import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function startLocalCompanion(loadServer = () => import("../apps/server/src/index.ts")) {
  process.chdir(fileURLToPath(new URL("../apps/server/", import.meta.url)));

  // The extension has a fixed loopback endpoint; local startup must not use managed identity.
  process.env.HOST = "127.0.0.1";
  process.env.PORT = "4317";
  process.env.NODE_ENV = "development";

  await loadServer();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await startLocalCompanion();
}
