import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  type TokenCredential,
} from "@azure/identity";
import type { AppConfig } from "./config.js";

export function createCredential(config: AppConfig): TokenCredential {
  if (config.NODE_ENV !== "production") {
    return new DefaultAzureCredential();
  }
  return config.AZURE_CLIENT_ID
    ? new ManagedIdentityCredential(config.AZURE_CLIENT_ID)
    : new ManagedIdentityCredential();
}
