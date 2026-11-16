import {
  foundryConfigurationSchema,
  resolvedFoundryConfigurationSchema,
  type FoundryConfiguration,
} from "@chrome-gpt-live/shared";
import { companionFetch } from "./companion";

export { COMPANION_URL } from "./companion";
const STORAGE_KEY = "foundryConfiguration";

export async function loadFoundryConfiguration(): Promise<FoundryConfiguration> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return foundryConfigurationSchema.parse(stored[STORAGE_KEY] ?? {});
}

export async function saveFoundryConfiguration(configuration: FoundryConfiguration): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: foundryConfigurationSchema.parse(configuration) });
}

export async function clearFoundryConfiguration(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

export async function resolveFoundryConfiguration(configuration: FoundryConfiguration) {
  const response = await companionFetch("/api/configuration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration),
  }, 10000);
  if (!response.ok) {
    throw new Error(`The companion rejected configuration (${response.status}): ${(await response.text()).slice(0, 1200)}`);
  }
  return resolvedFoundryConfigurationSchema.parse(await response.json());
}
