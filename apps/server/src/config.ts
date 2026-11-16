import { z } from "zod";
import {
  azureOpenAIEndpointSchema,
  DEFAULT_ASTRA_DEPLOYMENT,
  DEFAULT_LIVE_DEPLOYMENT,
  foundryConfigurationSchema,
  foundryProjectEndpointSchema,
  type FoundryConfiguration,
  type ResolvedFoundryConfiguration,
} from "@chrome-gpt-live/shared";

const optionalEnvironment = <T extends z.ZodType>(schema: T) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  schema.optional(),
);

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  HOST: z.string().default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  FOUNDRY_PROJECT_ENDPOINT: optionalEnvironment(foundryProjectEndpointSchema),
  AZURE_OPENAI_ENDPOINT: optionalEnvironment(azureOpenAIEndpointSchema),
  GPT_LIVE_DEPLOYMENT: optionalEnvironment(z.string().trim().min(1).max(128)),
  ASTRA_DEPLOYMENT: optionalEnvironment(z.string().trim().min(1).max(128)),
  DECISION_DEPLOYMENT: optionalEnvironment(z.string().trim().min(1).max(128)),
  DECISION_PROJECT_ENDPOINT: optionalEnvironment(foundryProjectEndpointSchema),
  DECISION_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  BROWSER_CONTROL: optionalEnvironment(z.enum(["astra", "md1-first"])),
  MD1_CLIENT_DELEGATION_VERIFIED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ASTRA_REASONING_EFFORT: z.enum(["low", "medium", "high"]).default("low"),
  GPT_LIVE_VOICE: z.string().min(1).default("marin"),
  AZURE_CLIENT_ID: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(environment);
}

export function resolveFoundryConfiguration(config: AppConfig, saved: FoundryConfiguration = {}): ResolvedFoundryConfiguration {
  const projectEndpoint = config.FOUNDRY_PROJECT_ENDPOINT ?? saved.projectEndpoint;
  const openAIEndpoint = config.AZURE_OPENAI_ENDPOINT ?? (projectEndpoint
    ? new URL(projectEndpoint).origin.replace(".services.ai.azure.com", ".openai.azure.com")
    : undefined);
  const decisionDeployment = config.DECISION_DEPLOYMENT ?? saved.decisionDeployment;
  const browserControl = config.BROWSER_CONTROL ?? saved.browserControl;
  return {
    values: {
      ...(projectEndpoint ? { projectEndpoint } : {}),
      ...(openAIEndpoint ? { openAIEndpoint } : {}),
      liveDeployment: config.GPT_LIVE_DEPLOYMENT ?? saved.liveDeployment ?? DEFAULT_LIVE_DEPLOYMENT,
      astraDeployment: config.ASTRA_DEPLOYMENT ?? saved.astraDeployment ?? DEFAULT_ASTRA_DEPLOYMENT,
      ...(decisionDeployment ? { decisionDeployment } : {}),
      ...(browserControl ? { browserControl } : {}),
    },
    overrides: {
      projectEndpoint: Boolean(config.FOUNDRY_PROJECT_ENDPOINT),
      openAIEndpoint: Boolean(config.AZURE_OPENAI_ENDPOINT),
      liveDeployment: Boolean(config.GPT_LIVE_DEPLOYMENT),
      astraDeployment: Boolean(config.ASTRA_DEPLOYMENT),
      decisionDeployment: Boolean(config.DECISION_DEPLOYMENT),
      ...(browserControl ? { browserControl: Boolean(config.BROWSER_CONTROL) } : {}),
    },
    ready: Boolean(projectEndpoint && openAIEndpoint),
    ...(browserControl ? { controller: effectiveController(config, browserControl, decisionDeployment) } : {}),
  };
}

export function requireFoundryConfiguration(config: AppConfig, saved?: FoundryConfiguration) {
  const resolved = resolveFoundryConfiguration(config, saved);
  return foundryConfigurationSchema.required().extend({
    openAIEndpoint: azureOpenAIEndpointSchema,
    decisionDeployment: foundryConfigurationSchema.shape.decisionDeployment,
    browserControl: foundryConfigurationSchema.shape.browserControl,
  }).parse(resolved.values);
}

export function effectiveController(config: AppConfig, requested?: string, decisionDeployment?: string) {
  const mode = requested === "md1-first" && decisionDeployment && config.MD1_CLIENT_DELEGATION_VERIFIED
    ? "md1-first" as const : "astra" as const;
  const reason = requested !== "md1-first" ? "Managed Astra (default)." :
    !decisionDeployment ? "MD-1-first inactive: no decision deployment configured." :
    !config.MD1_CLIENT_DELEGATION_VERIFIED ? "MD-1-first locked: verify the deployed client-delegation protocol, then set MD1_CLIENT_DELEGATION_VERIFIED=true." :
    "Experimental MD-1-first with Astra fallback.";
  return { mode, reason };
}
