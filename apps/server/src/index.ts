import "dotenv/config";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createCredential } from "./credential.js";

const config = loadConfig();
const credential = createCredential(config);
const app = buildApp(config, credential);

await app.listen({ host: config.HOST, port: config.PORT });
